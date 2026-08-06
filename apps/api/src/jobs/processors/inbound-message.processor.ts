import { Inject, Injectable, Logger } from '@nestjs/common';
import { SuppressionsService } from '../../calls/suppressions.service';
import { env } from '../../config/env';
import {
  ConversationsService,
  type PricedCatalogueEntry,
  type ReplyKind,
} from '../../conversations/conversations.service';
import { LeadsService } from '../../leads/leads.service';
import { SendCapService } from '../../telephony/send-cap.service';
import type { LlmTurn } from '../../conversations/llm.provider';
import type { CollectedAnswers } from '../../conversations/question-flow';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_LIST_SEGMENTS } from '../../services/service-options';
import { Prisma, type MessagePurpose } from '../../generated/prisma/client';
import {
  PermanentSendError,
  SMS_PROVIDER,
  type SmsProvider,
} from '../../telephony/sms.provider';
import {
  QUEUE,
  addJobBounded,
  queueToken,
  type InboundMessageJobData,
  type NotifyOwnerJobData,
} from '../queues';
import { Queue } from 'bullmq';

/**
 * Turns a customer's reply into the next message.
 *
 * Loads the thread, asks `ConversationsService` what to do, persists the answer, and
 * sends. It is the plumbing around a decision it does not make — the same division as
 * `RecoveryProcessor`, and the reason the state machine could be verified without a
 * database.
 *
 * Runs on the worker, never in a webhook. Extraction is a paid model call taking
 * seconds; Twilio times out around 15 (rule 8). The webhook's only job is to persist
 * the inbound message and enqueue this.
 */

/** How much of the thread the model sees. Matches the provider's own cap. */
const THREAD_WINDOW = 12;

/**
 * How long a claimed-but-unconfirmed send may sit before another worker may take it.
 *
 * Covers a process dying between claiming a row and calling the provider. Generous
 * enough that a slow provider call is never mistaken for a dead worker.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * Past this, an unsent reply is abandoned rather than delivered.
 *
 * A product limit. A question about a job the customer raised yesterday reads as the
 * system waking up at random; answering that late is worse than not answering.
 */
const MAX_UNSENT_AGE_MS = 15 * 60 * 1000;

/** At most one or two can realistically be outstanding; the cap is a safety rail. */
const MAX_FLUSH_BATCH = 5;

/**
 * How many segments an outbound reply of this purpose may occupy.
 *
 * Derived from `purpose` rather than passed down from the decision, because the flush
 * path re-sends a reserved row long after the decision that produced it is gone — and a
 * row it cannot classify is a reply it can never deliver.
 *
 * `QUALIFICATION` gets the menu's budget. That is a ceiling, not a licence: every fixed
 * prompt is asserted to a single segment at module load (`question-flow.ts`,
 * `service-options.ts`), and the only variable-length qualification body is the numbered
 * menu, which `buildServiceList` budget-checks when it builds it.
 *
 * Getting this wrong is not theoretical. The default of 1 is what made the two-segment
 * owner notification unsendable, and it would have done exactly the same to the menu —
 * silently, on the first business with four services.
 */
/** See `activeCatalogue` — a ceiling on a per-message query, not a business rule. */
const CATALOGUE_QUERY_LIMIT = 100;

function segmentAllowance(purpose: MessagePurpose | null): number {
  // `HANDOFF` shares the allowance because a handoff may now carry a quote: the
  // completion message is the price sentence plus the confirmation line, and a
  // `STARTING_FROM` quote with a long business name does not fit in 160 characters. The
  // qualifying clauses are what stop an estimate reading as a promise, so the budget
  // moves rather than the wording. Every fixed template is still asserted to a single
  // segment on its own at module load.
  // Named explicitly rather than defaulting to the wider budget: a permissive default
  // is how a purpose added later silently acquires an allowance nobody chose.
  return purpose === 'QUALIFICATION' || purpose === 'HANDOFF' ? MAX_LIST_SEGMENTS : 1;
}

@Injectable()
export class InboundMessageProcessor {
  private readonly logger = new Logger(InboundMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly suppressions: SuppressionsService,
    private readonly leads: LeadsService,
    private readonly sendCap: SendCapService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(queueToken(QUEUE.NOTIFY_OWNER))
    private readonly notifyQueue: Queue<NotifyOwnerJobData>,
  ) {}

  async process(data: InboundMessageJobData): Promise<void> {
    const { messageId, businessId } = data;

    const message = await this.prisma.db.message.findFirst({
      where: { businessId, id: messageId },
      include: { business: { select: { name: true, pricesIncludeGst: true } } },
    });

    if (!message) {
      this.logger.warn(`Inbound job for unknown message ${messageId} — dropping`);
      return;
    }
    if (message.direction !== 'INBOUND') {
      // A bug in whatever enqueued this. Loud, and terminal — it will never become
      // inbound, so re-driving it every minute would be pure noise.
      this.logger.error(`Message ${messageId} is ${message.direction}, not INBOUND — dropping`);
      await this.finish(messageId, businessId, 'FAILED', 'not an inbound message');
      return;
    }
    if (!message.customerId) {
      this.logger.warn(`Inbound message ${messageId} has no customer — dropping`);
      await this.finish(messageId, businessId, 'FAILED', 'no customer attributed');
      return;
    }

    const conversation = await this.findOrCreateConversation(businessId, message.customerId);

    // Terminal and never reopened, whatever they send afterwards.
    if (conversation.state === 'OPTED_OUT') {
      this.logger.log(`Conversation ${conversation.id} is opted out — not replying`);
      await this.finish(messageId, businessId, 'SKIPPED', 'conversation opted out');
      return;
    }

    // Deliver anything a previous attempt reserved but never sent, before deciding
    // anything new. This must run *before* the guard below, because that guard is
    // exactly what used to swallow the retry.
    const flushed = await this.flushUnsentReplies(businessId, message.customerId);
    if (flushed === 'blocked') {
      await this.finish(messageId, businessId, 'PENDING', 'unsent reply blocked by the send cap');
      return;
    }

    // Idempotency by state, not by job id. `lastInboundAt` advances only once a
    // reply has been fully processed, so a retried job sees its own message already
    // accounted for and stops.
    //
    // It also handles the case a jobId could not: two replies arriving in quick
    // succession. Whichever job runs second sees a `lastInboundAt` older than its
    // own message and proceeds — with the first reply already in the thread it
    // sends to the model. Out-of-order execution collapses to one reply covering
    // both, which is what a person would do.
    if (conversation.lastInboundAt && conversation.lastInboundAt >= message.createdAt) {
      this.logger.debug(`Message ${messageId} already processed — skipping`);
      // PROCESSED, not SKIPPED: the work genuinely happened, either on a previous
      // attempt of this job or in a later reply that superseded it. This is also the
      // path that repairs a crash between the conversation write and the status
      // write — without it the row would sit QUEUED forever.
      await this.finish(
        messageId,
        businessId,
        'PROCESSED',
        flushed === 'sent' ? 'reply re-sent after a failed attempt' : 'superseded by a later reply',
      );
      return;
    }

    // Re-checked here rather than trusted from the webhook: the job may have waited
    // while the customer sent STOP or the business drained its allowance, and the
    // state that matters is the state now.
    //
    // **Before extraction, deliberately.** Extraction is the expensive step; a capped
    // conversation that has already paid for a model call has spent money to discover
    // it was not allowed to spend money.
    const cap = await this.sendCap.check(businessId);
    if (!cap.allowed) {
      this.logger.warn(
        `Not replying to message ${messageId} — ${cap.detail}. Left PENDING for later.`,
      );
      // Back to PENDING, not SKIPPED. Both the kill switch and the cap are temporary
      // by design — the switch gets flipped back, the rolling window rolls — and these
      // customers are owed a reply when that happens. The reconciler re-drives them
      // automatically, and each retry costs one indexed count, no model call.
      await this.finish(messageId, businessId, 'PENDING', `blocked: ${cap.detail}`);
      return;
    }
    const suppressed = await this.suppressions.isSuppressed(businessId, message.fromE164);
    if (suppressed) {
      this.logger.log(`Not replying to ${message.fromE164}: ${suppressed}`);
      await this.finish(messageId, businessId, 'SKIPPED', `suppressed: ${suppressed}`);
      return;
    }

    const decision = await this.conversations.advance({
      businessName: message.business.name,
      conversation: {
        state: conversation.state,
        collected: (conversation.collected ?? {}) as CollectedAnswers,
        awaitingField: conversation.awaitingField,
        questionsAsked: conversation.questionsAsked,
        needsHuman: conversation.needsHuman,
        needsHumanReason: conversation.needsHumanReason,
        pendingChoice: conversation.pendingChoice,
        selectedServiceId: conversation.selectedServiceId,
      },
      inboundText: message.body,
      priorTurns: await this.priorTurns(businessId, message.customerId, message.createdAt),
      catalogue: await this.activeCatalogue(businessId),
      pricesIncludeGst: message.business.pricesIncludeGst,
    });

    if (decision.awaitingField && conversation.awaitingField) {
      const expected = this.conversations.attributableFields(conversation.awaitingField);
      const answered = expected.some((f) => decision.collected[f] !== undefined);
      if (!answered) {
        // Not an error — people reply out of order. Worth logging because a run of
        // these is the signal that extraction is failing rather than that customers
        // are confused.
        this.logger.log(
          `Reply to "${conversation.awaitingField}" did not answer it ` +
            `(conversation ${conversation.id})`,
        );
      }
    }

    // Persisted before sending, deliberately — the opposite of the recovery path,
    // and for the opposite reason. There, a row written first could suppress a real
    // send. Here, a send that succeeds while the state write is lost would ask the
    // same question again on the next reply, which the customer experiences as the
    // system not listening. Re-sending is the cheaper failure.
    await this.prisma.db.conversation.update({
      where: { id: conversation.id, businessId },
      data: {
        state: decision.state,
        collected: decision.collected as object,
        awaitingField: decision.awaitingField,
        questionsAsked: decision.questionsAsked,
        needsHuman: decision.needsHuman,
        needsHumanReason: decision.needsHumanReason,
        // Written on every advance, never left alone. An outstanding menu that is not
        // explicitly cleared is one the *next* reply gets resolved against, long after
        // the question stopped applying — so the decision always states which it is.
        // `DbNull` sets SQL NULL; a plain `null` on a `Json?` column is ambiguous in
        // Prisma and would not clear it. The cast is the interface-to-`InputJsonObject`
        // boundary — a declared interface has no index signature, which is what Prisma's
        // JSON input type requires.
        pendingChoice:
          decision.pendingChoice === null
            ? Prisma.DbNull
            : (decision.pendingChoice as unknown as Prisma.InputJsonObject),
        selectedServiceId: decision.selectedServiceId,
        lastInboundAt: message.createdAt,
        completedAt: decision.state === 'COMPLETE' ? new Date() : null,
      },
    });

    // A call is not a lead; a reply is (docs/decisions.md). Synced on **every**
    // advance rather than only the first: a lead written once and never updated shows
    // the owner whatever was known thirty seconds in — usually a suburb and nothing
    // else — which is worse than no lead, because it looks complete.
    //
    // After the conversation write, deliberately. If this fails, the conversation
    // state is still correct and the retry re-syncs from it; the reverse ordering
    // would leave a lead describing a conversation that never advanced.
    const lead = await this.leads.syncFromConversation({
      businessId,
      customerId: message.customerId,
      conversationId: conversation.id,
      collected: decision.collected,
      conversationComplete: decision.state === 'COMPLETE',
      needsHuman: decision.needsHuman,
      needsHumanReason: decision.needsHumanReason,
      stillMissing: decision.stillMissing,
      urgency: decision.urgency,
      selectedServiceId: decision.selectedServiceId,
      quote: decision.quote,
    });

    // Tell the owner as soon as the lead is worth telling them about — not on every
    // reply, which would text them once per question.
    //
    // Enqueue failures are swallowed on purpose: `ownerNotifiedAt` is the outbox
    // marker, so the maintenance sweep re-drives anything Redis refused. The customer's
    // reply must not fail because the owner's copy could not be queued.
    if (lead.status === 'QUALIFIED' && lead.ownerNotifiedAt === null) {
      try {
        await addJobBounded(
          this.notifyQueue,
          'notify-owner',
          { leadId: lead.id, businessId },
          { jobId: `notify-${lead.id}` },
        );
      } catch (error) {
        this.logger.error(
          `Could not queue the owner notification for lead ${lead.id}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            'It stays un-notified and the sweep will re-drive it.',
        );
      }
    }

    await this.reply(message, businessId, decision.reply.kind, decision.reply.body);

    // Last, and only on the success path. A transient model or SMS failure throws
    // before reaching here, leaving the row QUEUED for BullMQ's retry — which is
    // correct, because the work is genuinely still outstanding.
    await this.finish(messageId, businessId, 'PROCESSED', null);

    this.logger.log(
      `Conversation ${conversation.id} → ${decision.state} ` +
        `(${decision.usage.inputTokens}+${decision.usage.outputTokens} tokens, ${decision.latencyMs}ms` +
        `${decision.stillMissing.length ? `, missing ${decision.stillMissing.join('/')}` : ''})`,
    );
  }

  /**
   * Record the terminal processing state of an inbound message.
   *
   * Every exit path from `process()` goes through here, so no row is left in QUEUED
   * with nothing to explain it. `PENDING` is a legitimate argument: it hands the
   * message back to the reconciler for a genuinely temporary condition.
   *
   * Deliberately not wrapped in a transaction with the conversation write. If this
   * update is the thing that fails, the retry hits the `lastInboundAt` check above and
   * lands on PROCESSED — self-healing, and cheaper than a transaction spanning an
   * external send.
   */
  private async finish(
    messageId: string,
    businessId: string,
    status: 'PENDING' | 'PROCESSED' | 'SKIPPED' | 'FAILED',
    note: string | null,
  ): Promise<void> {
    await this.prisma.db.message.update({
      where: { id: messageId, businessId },
      data: {
        processingStatus: status,
        // Only a terminal state gets a timestamp; PENDING is going back in the queue.
        processedAt: status === 'PENDING' ? null : new Date(),
        processingNote: note,
      },
    });
  }

  /**
   * The open conversation for this customer, creating or reopening as needed.
   *
   * `EXPIRED` reopens: someone who texts back two days later is still a lead, and
   * starting a fresh thread would re-ask everything they already answered. Only
   * `OPTED_OUT` is truly terminal.
   */
  private async findOrCreateConversation(businessId: string, customerId: string) {
    const existing = await this.prisma.db.conversation.findFirst({
      where: {
        businessId,
        customerId,
        state: { in: ['AWAITING_FIRST_REPLY', 'COLLECTING', 'OPTED_OUT', 'EXPIRED'] },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (existing?.state === 'EXPIRED') {
      this.logger.log(`Reopening expired conversation ${existing.id}`);
      return this.prisma.db.conversation.update({
        where: { id: existing.id, businessId },
        // The menu goes with the expiry. A conversation only expires after 48 hours of
        // silence, so whatever they are saying now is not an answer to a list they were
        // sent two days ago — and resolving "1" against it would attribute a service
        // they never chose in this exchange. They get asked again.
        data: { state: 'COLLECTING', pendingChoice: Prisma.DbNull },
      });
    }
    if (existing) return existing;

    // No prior conversation — a reply to a number that never called, or one whose
    // conversation was already completed. Either way they are talking to us now.
    this.logger.log(`Starting a conversation for customer ${customerId} from an inbound reply`);
    return this.prisma.db.conversation.create({
      data: { businessId, customerId, state: 'AWAITING_FIRST_REPLY', lastInboundAt: null },
    });
  }

  /**
   * The business's active services, for building a menu and for re-validating a choice.
   *
   * `ACTIVE` only. A disabled or deleted service is absent from this list, and
   * `isStillSelectable` correctly refuses anything it cannot find — so the two cases
   * collapse into one without a second query.
   *
   * Bounded by `take`. Valid data cannot exceed `MAX_ACTIVE_SERVICES`, but this runs on
   * every inbound reply and a catalogue that bypassed validation is exactly the case
   * where the number could be large. Anything over the limit trips `TOO_MANY_ACTIVE`
   * either way, so the cap costs nothing except a slightly under-reported count in the
   * alert detail.
   */
  private async activeCatalogue(businessId: string): Promise<PricedCatalogueEntry[]> {
    return this.prisma.db.service.findMany({
      where: { businessId, availability: 'ACTIVE' },
      // Every column pricing reads, not just the four the menu needs. Selected
      // explicitly rather than fetching the row wholesale, so adding a column to
      // `services` cannot quietly widen what a conversation loads on every reply.
      select: {
        id: true, name: true, availability: true, sortOrder: true,
        pricingType: true, priceCents: true, unitLabel: true, minUnits: true, maxUnits: true,
        showPriceAutomatically: true, priceConfidence: true, requiresConfirmation: true,
        requiredFields: true,
      },
      orderBy: { sortOrder: 'asc' },
      take: CATALOGUE_QUERY_LIMIT,
    });
  }

  /**
   * The thread so far, oldest first, excluding the message being processed.
   *
   * Reconstructed from `messages` rather than stored on the conversation: `messages`
   * is already the record of what was actually said, and a second copy would be a
   * second thing to keep in sync.
   */
  private async priorTurns(
    businessId: string,
    customerId: string,
    before: Date,
  ): Promise<LlmTurn[]> {
    const rows = await this.prisma.db.message.findMany({
      where: { businessId, customerId, createdAt: { lt: before } },
      orderBy: { createdAt: 'desc' },
      take: THREAD_WINDOW,
      select: { direction: true, body: true },
    });

    return rows.reverse().map(
      (m): LlmTurn => ({
        role: m.direction === 'INBOUND' ? 'customer' : 'business',
        text: m.body,
      }),
    );
  }

  /**
   * Send the reply and record it.
   *
   * The message row is written *after* the provider call, as in the recovery path:
   * a row claiming a message that was never queued is worse than a missing record of
   * one that was.
   */
  private async reply(
    inbound: { customerId: string | null; fromE164: string; toE164: string },
    businessId: string,
    kind: ReplyKind,
    body: string,
  ): Promise<void> {
    // The number they texted is the number we reply from — swapping `to` and `from`
    // rather than looking the business's number up again, so a mid-conversation
    // number change cannot move the thread to a different sender.
    const from = inbound.toE164;
    const to = inbound.fromE164;
    // A menu and a re-prompt are both qualification traffic — they are asking the
    // customer for the same field, in a different shape.
    const purpose = kind === 'handoff' ? 'HANDOFF' : 'QUALIFICATION';

    // **Reserved before the provider is called.** A row with a null
    // `providerMessageSid` is a durable "we owe this customer these exact words" —
    // which is what makes a transient send failure recoverable at all.
    //
    // This is the opposite ordering to `RecoveryProcessor`, deliberately. There, a row
    // written first would *suppress* the retry, because its idempotency check is the
    // existence of the row. Here the unsent row *drives* the retry instead. Both are
    // correct; they defend opposite failures.
    const reserved = await this.prisma.db.message.create({
      data: {
        businessId,
        customerId: inbound.customerId,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        purpose,
        fromE164: from,
        toE164: to,
        body,
        providerMessageSid: null,
        // Doubles as the concurrency claim — see `claim()`.
        sentAt: new Date(),
      },
    });

    await this.deliver(reserved.id, businessId, { from, to, body }, segmentAllowance(purpose));
  }

  /**
   * Send a reserved row and confirm it, or leave it recoverable.
   *
   * Split out so the retry path can reuse it without touching the model, the
   * conversation or the lead.
   */
  private async deliver(
    messageId: string,
    businessId: string,
    sms: { from: string; to: string; body: string },
    maxSegments: number,
  ): Promise<void> {
    try {
      const result = await this.sms.sendSms({
        to: sms.to,
        from: sms.from,
        body: sms.body,
        maxSegments,
        statusCallbackUrl: `${env.PUBLIC_API_URL}/webhooks/twilio/messages/status`,
      });

      // Confirmation. The sid is what takes this row out of the unsent set, so this
      // write is the thing that makes the send idempotent.
      await this.prisma.db.message.update({
        where: { id: messageId, businessId },
        data: {
          providerMessageSid: result.providerMessageSid,
          segments: result.segments,
          sentAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof PermanentSendError) {
        this.logger.warn(`Permanent failure replying to ${sms.to}: ${error.message}`);
        // Terminal: FAILED takes it out of the unsent set for good, so nothing
        // re-sends something guaranteed to be rejected again.
        await this.prisma.db.message.update({
          where: { id: messageId, businessId },
          data: { status: 'FAILED', errorCode: error.code, errorMessage: error.message },
        });
        if (error.code === 21610) await this.suppressions.optOut(businessId, sms.to);
        // Swallowed: retrying is guaranteed to fail identically.
        return;
      }

      // Transient. Release the claim so the retry can pick the row up, and rethrow so
      // BullMQ actually retries. The row keeps its null sid, which is what the flush
      // step looks for.
      await this.prisma.db.message.updateMany({
        where: { id: messageId, businessId, providerMessageSid: null },
        data: { sentAt: null },
      });
      throw error;
    }
  }

  /**
   * Send any reply that was reserved but never confirmed, before doing anything else.
   *
   * The bug this closes: `lastInboundAt` proves the customer's reply was *processed*,
   * not that the resulting SMS was *sent*. It was written before the send, so a
   * transient Twilio failure left the conversation and lead saved, the SMS unsent, and
   * the BullMQ retry skipping straight past on the `>=` comparison — marking the
   * message PROCESSED with the note "superseded by a later reply" while the customer
   * sat in silence. The job even completed successfully, so nothing alerted.
   *
   * Deliberately **flush and continue** rather than flush and return. If the unsent row
   * belongs to an earlier inbound message, returning here would mark the *current*
   * message processed without ever answering it — turning one lost reply into two. On
   * the retry path the `lastInboundAt` guard below still stops the duplicate work,
   * which is the intended behaviour.
   *
   * Scoping by customer is safe rather than approximate: every other outbound writer
   * (`RecoveryProcessor`, `NotifyOwnerProcessor`) creates its row *after* the provider
   * call, so a row with a null `providerMessageSid` and `status: QUEUED` can only have
   * come from the reserve step above.
   */
  private async flushUnsentReplies(
    businessId: string,
    customerId: string,
  ): Promise<'none' | 'sent' | 'blocked'> {
    const now = Date.now();

    const unsent = await this.prisma.db.message.findMany({
      where: {
        businessId,
        customerId,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        providerMessageSid: null,
        // Either unclaimed, or claimed so long ago that the claimant is presumed dead.
        // Without the second case a process that died between claiming and sending
        // would strand the row forever — the same silence this method exists to fix.
        OR: [{ sentAt: null }, { sentAt: { lt: new Date(now - STALE_CLAIM_MS) } }],
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_FLUSH_BATCH,
    });

    if (unsent.length === 0) return 'none';

    let sent = 0;
    for (const row of unsent) {
      // Too old to be worth sending. A question about a job the customer asked about
      // yesterday reads as a system waking up at random, and answering it now is worse
      // than not answering — the conversation has moved on.
      if (row.createdAt.getTime() < now - MAX_UNSENT_AGE_MS) {
        await this.prisma.db.message.update({
          where: { id: row.id, businessId },
          data: {
            status: 'FAILED',
            errorMessage: 'abandoned: never sent and now too old to be useful',
          },
        });
        this.logger.error(
          `Reply to ${row.toE164} was never sent and is now stale — abandoned. ` +
            'That customer received no answer.',
        );
        continue;
      }

      // Re-checked at the moment of sending, not trusted from the first attempt. A
      // STOP between attempts is the case that matters: sending after it is the one
      // thing the opt-out absolutely forbids.
      const suppressed = await this.suppressions.isSuppressed(businessId, row.toE164);
      if (suppressed) {
        await this.prisma.db.message.update({
          where: { id: row.id, businessId },
          data: { status: 'FAILED', errorMessage: `not sent: ${suppressed} before delivery` },
        });
        this.logger.log(`Unsent reply to ${row.toE164} cancelled: ${suppressed}`);
        continue;
      }

      const cap = await this.sendCap.check(businessId);
      if (!cap.allowed) {
        // Left untouched so it is retried once the window rolls or the switch flips.
        this.logger.warn(`Cannot flush unsent reply to ${row.toE164} — ${cap.detail}`);
        return 'blocked';
      }

      // Compare-and-set claim. Two workers can be processing two different replies for
      // the same customer at once (inbound concurrency is 2), and both would find this
      // row. Only the update that actually changes it proceeds.
      const claim = await this.prisma.db.message.updateMany({
        where: { id: row.id, businessId, providerMessageSid: null, sentAt: row.sentAt },
        data: { sentAt: new Date() },
      });
      if (claim.count === 0) continue;

      await this.deliver(
        row.id,
        businessId,
        { from: row.fromE164, to: row.toE164, body: row.body },
        segmentAllowance(row.purpose),
      );
      sent += 1;
      this.logger.log(`Re-sent a reply to ${row.toE164} that a previous attempt never delivered`);
    }

    return sent > 0 ? 'sent' : 'none';
  }
}
