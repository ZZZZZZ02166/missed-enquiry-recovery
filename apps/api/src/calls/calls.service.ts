import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import type { Call, Customer, NoRecoveryReason } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SuppressionsService } from './suppressions.service';

/**
 * Turns a recorded voice webhook into a `Call`, and decides whether the caller
 * should get a recovery SMS.
 *
 * The decision is the product. Texting the wrong person costs money and trust:
 * a landline send fails and still bills us, an opt-out breaches the Spam Act, and
 * "What service do you need?" is jarring when the caller is your own plumber ringing
 * about today's job. Every skip is recorded with a reason (D5, `NoRecoveryReason`),
 * so "why did this caller never hear from us?" stays answerable.
 *
 * Nothing here sends anything. It records the decision; the queue acts on it.
 */

/** Twilio `CallStatus` → our outcome. Unknown values fall back rather than throw. */
const OUTCOME_BY_STATUS: Record<string, Call['outcome']> = {
  queued: 'IN_PROGRESS',
  ringing: 'IN_PROGRESS',
  'in-progress': 'IN_PROGRESS',
  completed: 'COMPLETED',
  'no-answer': 'NO_ANSWER',
  busy: 'BUSY',
  failed: 'FAILED',
  canceled: 'CANCELED',
};

/**
 * One recovery SMS per caller per business per 24h.
 *
 * A caller who rings three times in five minutes — which is exactly what someone
 * does when they need a cleaner today — must get one text, not three.
 */
const RECONTACT_WINDOW_HOURS = 24;

export interface RecordCallInput {
  businessId: string;
  providerCallSid: string;
  /** Already E.164-normalised, or null for a withheld caller ID. */
  fromE164: string | null;
  toE164: string;
  forwardedFromE164?: string | null;
  callStatus?: string;
}

export interface CallDecision {
  call: Call;
  customer: Customer | null;
  /** True when the queue should send a recovery SMS. */
  shouldRecover: boolean;
  /** Set when it should not. Mirrors `call.noRecoveryReason`. */
  reason: NoRecoveryReason | null;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppressions: SuppressionsService,
  ) {}

  /**
   * Record an inbound call and decide what to do about it.
   *
   * Idempotent on `providerCallSid`: a replayed webhook returns the existing call
   * and its original decision rather than re-deciding. Re-deciding would be worse
   * than useless — the throttle check would see the first attempt and skip, turning
   * a retry into a permanent `RECENTLY_CONTACTED`.
   */
  async recordInboundCall(input: RecordCallInput): Promise<CallDecision> {
    const existing = await this.prisma.db.call.findFirst({
      where: { businessId: input.businessId, providerCallSid: input.providerCallSid },
      include: { customer: true },
    });

    if (existing) {
      return {
        call: existing,
        customer: existing.customer,
        shouldRecover: existing.recoverySmsQueuedAt !== null,
        reason: existing.noRecoveryReason,
      };
    }

    const customer = input.fromE164
      ? await this.upsertCustomer(input.businessId, input.fromE164)
      : null;

    const reason = await this.decideRecovery(input, customer);

    const call = await this.prisma.db.call.create({
      data: {
        businessId: input.businessId,
        customerId: customer?.id ?? null,
        providerCallSid: input.providerCallSid,
        fromE164: input.fromE164,
        toE164: input.toE164,
        forwardedFromE164: input.forwardedFromE164 ?? null,
        outcome: this.outcomeFor(input.callStatus),
        noRecoveryReason: reason,
        // Set now, not on delivery: this marks the decision, and the message's own
        // status lives on `messages`. Recording it here means a crash between
        // deciding and enqueuing cannot produce a second text on retry.
        recoverySmsQueuedAt: reason === null ? new Date() : null,
      },
    });

    if (reason) {
      this.logger.log(`Call ${input.providerCallSid}: no recovery (${reason})`);
    }

    return { call, customer, shouldRecover: reason === null, reason };
  }

  /**
   * Update the call when a status callback arrives.
   *
   * Terminal outcomes are never overwritten. Callbacks arrive out of order, so a
   * late `ringing` after `completed` must not walk the call backwards.
   */
  async applyStatus(
    businessId: string,
    providerCallSid: string,
    callStatus: string,
    durationSeconds?: number,
  ): Promise<Call | null> {
    const call = await this.prisma.db.call.findFirst({
      where: { businessId, providerCallSid },
    });
    if (!call) return null;

    const outcome = this.outcomeFor(callStatus);
    if (this.isTerminal(call.outcome) && outcome === 'IN_PROGRESS') {
      return call;
    }

    return this.prisma.db.call.update({
      where: { id: call.id, businessId },
      data: {
        outcome,
        durationSeconds: durationSeconds ?? call.durationSeconds,
        endedAt: this.isTerminal(outcome) ? (call.endedAt ?? new Date()) : call.endedAt,
      },
    });
  }

  /**
   * Why this caller should not be texted, or null to proceed.
   *
   * Ordered cheapest-first, and by how definitive each check is. The ordering is not
   * cosmetic: `ANONYMOUS_CALLER` needs no query at all, while the throttle check
   * touches the calls table, so a withheld number never causes a database round trip.
   */
  private async decideRecovery(
    input: RecordCallInput,
    customer: Customer | null,
  ): Promise<NoRecoveryReason | null> {
    // Nobody to text. Free to detect, and the most common non-textable case.
    if (!input.fromE164 || !customer) return 'ANONYMOUS_CALLER';

    // Global kill switch / spend cap, before anything caller-specific.
    if (!env.SENDING_ENABLED) return 'CAP_REACHED';

    // Opt-outs, the owner's blocklist, and cached non-textable numbers — one indexed
    // lookup covering all three. First of the caller-specific checks because it is
    // the only one with legal weight: texting someone who replied STOP is a Spam Act
    // breach, and no other reason to skip outranks that.
    //
    // NOT_TEXTABLE from a suppression row is mapped to the same reason as the
    // lineType check below; the difference is only which write got there first.
    const suppressed = await this.suppressions.isSuppressed(input.businessId, input.fromE164);
    if (suppressed) {
      return suppressed === 'NOT_TEXTABLE' ? 'NOT_TEXTABLE' : 'SUPPRESSED';
    }

    // Staff, suppliers, existing customers mid-job. They are on the do-not-SMS list
    // precisely because a qualification question would be nonsense to them.
    if (customer.isKnownContact) return 'KNOWN_CONTACT';

    // A landline send fails at the carrier and we are billed anyway. UNKNOWN is
    // allowed through — Lookup runs before the send, in the worker, so this is not
    // the last line of defence.
    if (customer.lineType === 'LANDLINE' || customer.lineType === 'TOLL_FREE') {
      return 'NOT_TEXTABLE';
    }

    // One text per caller per 24h. Counts calls we actually queued a text for, not
    // calls received — three rings in five minutes is one conversation.
    const since = new Date(Date.now() - RECONTACT_WINDOW_HOURS * 60 * 60 * 1000);
    const recent = await this.prisma.db.call.count({
      where: {
        businessId: input.businessId,
        customerId: customer.id,
        recoverySmsQueuedAt: { gte: since },
      },
    });
    // `MAX_SMS_PER_NUMBER_PER_DAY` (default 1) is what this enforces. It was declared
    // in the env schema and never read — config that implied a protection nobody had
    // actually written. Reading it here keeps the same default behaviour and makes the
    // knob real.
    if (recent >= env.MAX_SMS_PER_NUMBER_PER_DAY) return 'RECENTLY_CONTACTED';

    // Per-business cap, counting *calls with a recovery queued*.
    //
    // This is a cheap pre-filter, not the ceiling. One recovered call becomes a whole
    // conversation — recovery, questions, handoff — so counting calls here would
    // permit several times this number of actual messages. The real ceiling counts
    // messages at send time in `SendCapService`; this exists to keep obviously
    // hopeless work out of the queue before it costs anything.
    const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const today = await this.prisma.db.call.count({
      where: { businessId: input.businessId, recoverySmsQueuedAt: { gte: dayStart } },
    });
    if (today >= env.MAX_SMS_PER_BUSINESS_PER_DAY) {
      // Warn, not log: hitting the cap is either a very good day or a runaway loop,
      // and both warrant a human looking.
      this.logger.warn(
        `Business ${input.businessId} hit the daily recovery cap (${env.MAX_SMS_PER_BUSINESS_PER_DAY})`,
      );
      return 'CAP_REACHED';
    }

    return null;
  }

  /**
   * Find or create the customer for this number.
   *
   * `upsert` rather than find-then-create: two calls from the same number can arrive
   * concurrently, and the unique index on (businessId, phoneE164) would reject the
   * loser of that race.
   */
  private async upsertCustomer(businessId: string, phoneE164: string): Promise<Customer> {
    return this.prisma.db.customer.upsert({
      where: { businessId, businessId_phoneE164: { businessId, phoneE164 } },
      create: { businessId, phoneE164 },
      // Touch nothing. The customer already exists; a call is not new information
      // about them, and overwriting a learned name with nothing would lose data.
      update: {},
    });
  }

  private outcomeFor(callStatus?: string): Call['outcome'] {
    if (!callStatus) return 'IN_PROGRESS';
    const mapped = OUTCOME_BY_STATUS[callStatus.toLowerCase()];
    if (!mapped) {
      // Unknown status from Twilio. Don't throw — an unrecognised value must not
      // break call recording. Log it so a new Twilio status is noticed.
      this.logger.warn(`Unrecognised Twilio CallStatus: ${callStatus}`);
      return 'IN_PROGRESS';
    }
    return mapped;
  }

  private isTerminal(outcome: Call['outcome']): boolean {
    return outcome !== 'IN_PROGRESS';
  }
}
