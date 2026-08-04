import { Inject, Injectable, Logger } from '@nestjs/common';
import { SuppressionsService } from '../../calls/suppressions.service';
import { env } from '../../config/env';
import {
  prepareBusinessNameVerbose,
  recoveryFirstMessage,
  recoveryKnownContactMessage,
} from '../../notifications/templates';
import { PrismaService } from '../../prisma/prisma.service';
import { SendCapService } from '../../telephony/send-cap.service';
import {
  PermanentSendError,
  SMS_PROVIDER,
  type LookupLineType,
  type SmsProvider,
} from '../../telephony/sms.provider';
import type { RecoveryJobData } from '../queues';

/**
 * Sends the recovery SMS.
 *
 * Runs in the worker, never in a webhook: Twilio times out around 15 seconds, and a
 * send inside the request would make the caller's greeting depend on Twilio's
 * messaging API being fast.
 *
 * Every check the decision path already made is made **again** here. That is not
 * redundancy — the job may have sat in the queue while the customer replied STOP, and
 * the state that matters is the state at send time, not at decision time. This is why
 * job payloads carry ids rather than entities.
 */

/** Twilio Lookup line types we must not text. */
const UNTEXTABLE: ReadonlySet<LookupLineType> = new Set(['landline', 'tollFree']);

/** Lookup line type → the enum stored on `customers`. */
const LINE_TYPE_TO_DB = {
  mobile: 'MOBILE',
  landline: 'LANDLINE',
  voip: 'VOIP',
  fixedVoip: 'VOIP',
  nonFixedVoip: 'VOIP',
  tollFree: 'TOLL_FREE',
  unknown: 'UNKNOWN',
} as const;

@Injectable()
export class RecoveryProcessor {
  private readonly logger = new Logger(RecoveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppressions: SuppressionsService,
    private readonly sendCap: SendCapService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  async process(data: RecoveryJobData): Promise<void> {
    const { callId, businessId } = data;

    const call = await this.prisma.db.call.findFirst({
      where: { businessId, id: callId },
      include: { customer: true, business: { select: { name: true } } },
    });

    if (!call) {
      // The business was deleted, or the id is wrong. Nothing to retry towards.
      this.logger.warn(`Recovery job for unknown call ${callId} — dropping`);
      return;
    }

    // Idempotency. A retried job, or a duplicate enqueue, must not send twice: the
    // caller receives one text, however many times this runs.
    const already = await this.prisma.db.message.findFirst({
      where: { businessId, callId, purpose: 'RECOVERY', direction: 'OUTBOUND' },
      select: { id: true },
    });
    if (already) {
      this.logger.debug(`Recovery already sent for call ${callId} — skipping`);
      return;
    }

    const customer = call.customer;
    if (!call.fromE164 || !customer) {
      await this.recordNoSend(call.id, businessId, 'ANONYMOUS_CALLER');
      return;
    }

    // Re-checked at send time, not trusted from the decision. The kill switch may
    // have been thrown, or the business may have drained its allowance, while this
    // job waited — and after an outage the reconciler releases a backlog in batches,
    // which is exactly when a ceiling has to hold.
    //
    // Note this counts *messages*, while `decideRecovery` counts calls. Both exist on
    // purpose: the call-based check keeps hopeless work out of the queue cheaply, and
    // this one is the actual ceiling on spend.
    const cap = await this.sendCap.check(businessId);
    if (!cap.allowed) {
      this.logger.warn(`Not sending recovery for call ${callId} — ${cap.detail}`);
      await this.recordNoSend(call.id, businessId, 'CAP_REACHED');
      return;
    }

    // The customer may have replied STOP to a different business's message, or the
    // owner may have blocked them, between the call and now.
    const suppressed = await this.suppressions.isSuppressed(businessId, call.fromE164);
    if (suppressed) {
      this.logger.log(`Not sending to ${call.fromE164}: ${suppressed}`);
      await this.recordNoSend(
        call.id,
        businessId,
        suppressed === 'NOT_TEXTABLE' ? 'NOT_TEXTABLE' : 'SUPPRESSED',
      );
      return;
    }

    // Lookup once per number, ever. A landline send fails at the carrier and is
    // billed anyway; at ~US$0.008 the lookup is cheaper than one wasted send.
    if (customer.lineType === 'UNKNOWN') {
      const notTextable = await this.checkLineType(businessId, customer.id, call.fromE164);
      if (notTextable) {
        await this.recordNoSend(call.id, businessId, 'NOT_TEXTABLE');
        return;
      }
    }

    const smsNumber = await this.smsNumberFor(businessId);
    if (!smsNumber) {
      // A business with no SMS number cannot be recovered from. Throwing makes this
      // retry — correct, because the number may be mid-provisioning — and leaves the
      // job visible in the failed set rather than silently dropped.
      throw new Error(`Business ${businessId} has no ACTIVE SMS number; cannot send recovery`);
    }

    const { name, stripped } = prepareBusinessNameVerbose(call.business.name);
    if (stripped.length > 0) {
      // Degrading silently is how a mangled name goes unnoticed for months.
      this.logger.warn(
        `Business ${businessId} name contains unsendable characters ${stripped.join(' ')} — ` +
          `sending as "${name}". The owner should correct it.`,
      );
    }

    const body = customer.isKnownContact
      ? recoveryKnownContactMessage(name)
      : recoveryFirstMessage(name);

    await this.send(call.id, businessId, customer.id, smsNumber, call.fromE164, body);
  }

  /**
   * Send, and record the outcome either way.
   *
   * The `messages` row is written *after* the provider call, deliberately: writing it
   * first would mean a crash mid-send leaves a row claiming a message that was never
   * queued, and the idempotency check above would then suppress the retry. Losing the
   * record of a failure is recoverable; suppressing a real send is not.
   *
   * **The opposite of `InboundMessageProcessor`, and both are correct.** There, the
   * row is reserved *before* the send, because an unsent row is what *drives* its
   * retry rather than suppressing it. The difference is which side the idempotency
   * marker sits on: here the row's existence means "already sent", there a null
   * `providerMessageSid` means "not sent yet".
   */
  private async send(
    callId: string,
    businessId: string,
    customerId: string,
    from: string,
    to: string,
    body: string,
  ): Promise<void> {
    try {
      const result = await this.sms.sendSms({
        to,
        from,
        body,
        statusCallbackUrl: `${env.PUBLIC_API_URL}/webhooks/twilio/messages/status`,
      });

      await this.prisma.db.message.create({
        data: {
          businessId,
          customerId,
          callId,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          purpose: 'RECOVERY',
          fromE164: from,
          toE164: to,
          body,
          providerMessageSid: result.providerMessageSid,
          segments: result.segments,
          sentAt: new Date(),
        },
      });

      this.logger.log(`Recovery SMS queued for call ${callId} (${result.segments} segment)`);
    } catch (error) {
      if (error instanceof PermanentSendError) {
        await this.handlePermanentFailure(error, callId, businessId, customerId, from, to, body);
        // Swallowed: BullMQ must not retry something that will fail identically.
        return;
      }
      // Transient — let BullMQ retry with backoff.
      throw error;
    }
  }

  /**
   * A failure that will not change on retry.
   *
   * 21610 is the one that matters: Twilio's own opt-out list rejected the send even
   * though our suppression table did not. Twilio is authoritative for what actually
   * gets delivered, so we back-fill a suppression row — otherwise every future call
   * from this number burns another API call to be rejected again.
   */
  private async handlePermanentFailure(
    error: PermanentSendError,
    callId: string,
    businessId: string,
    customerId: string,
    from: string,
    to: string,
    body: string,
  ): Promise<void> {
    this.logger.warn(`Permanent send failure for call ${callId}: ${error.message}`);

    await this.prisma.db.message.create({
      data: {
        businessId,
        customerId,
        callId,
        direction: 'OUTBOUND',
        status: 'FAILED',
        purpose: 'RECOVERY',
        fromE164: from,
        toE164: to,
        body,
        errorCode: error.code,
        errorMessage: error.message,
      },
    });

    if (error.code === 21610) {
      await this.suppressions.optOut(businessId, to);
      await this.setNoRecoveryReason(callId, businessId, 'SUPPRESSED');
      return;
    }

    if (error.code === 21614 || error.code === 21211) {
      await this.suppressions.markNotTextable(businessId, to, 'twilio-rejected');
      await this.setNoRecoveryReason(callId, businessId, 'NOT_TEXTABLE');
    }
  }

  /**
   * Lookup, cache on the customer, and suppress if the number cannot receive SMS.
   *
   * Written to both `customers.lineType` and `suppressions` — the customer row caches
   * what Lookup said, the suppression row is the decision not to send. The send path
   * trusts the suppression.
   */
  private async checkLineType(
    businessId: string,
    customerId: string,
    phoneE164: string,
  ): Promise<boolean> {
    const { lineType } = await this.sms.lookup(phoneE164);

    await this.prisma.db.customer.update({
      where: { id: customerId, businessId },
      data: { lineType: LINE_TYPE_TO_DB[lineType], lineTypeAt: new Date() },
    });

    if (!UNTEXTABLE.has(lineType)) return false;

    await this.suppressions.markNotTextable(businessId, phoneE164, lineType);
    this.logger.log(`${phoneE164} is a ${lineType} — suppressed, not texted`);
    return true;
  }

  /** The business's ACTIVE two-way SMS number. */
  private async smsNumberFor(businessId: string): Promise<string | null> {
    const number = await this.prisma.db.phoneNumber.findFirst({
      where: { businessId, purpose: 'SMS_TWO_WAY', status: 'ACTIVE' },
      select: { e164: true },
    });
    return number?.e164 ?? null;
  }

  /** Record that no message was sent, and why, clearing the queued marker. */
  private async recordNoSend(
    callId: string,
    businessId: string,
    reason: 'ANONYMOUS_CALLER' | 'NOT_TEXTABLE' | 'SUPPRESSED' | 'CAP_REACHED',
  ): Promise<void> {
    await this.prisma.db.call.update({
      where: { id: callId, businessId },
      // Clearing `recoverySmsQueuedAt` matters: it is what the 24h throttle counts,
      // and leaving it set would suppress a legitimate recovery on the next call.
      data: { noRecoveryReason: reason, recoverySmsQueuedAt: null },
    });
  }

  private async setNoRecoveryReason(
    callId: string,
    businessId: string,
    reason: 'SUPPRESSED' | 'NOT_TEXTABLE',
  ): Promise<void> {
    await this.prisma.db.call.update({
      where: { id: callId, businessId },
      data: { noRecoveryReason: reason },
    });
  }
}
