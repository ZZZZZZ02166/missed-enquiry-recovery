import { Body, Controller, Header, HttpCode, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { Queue } from 'bullmq';
import { twiml } from 'twilio';
import { SuppressionsService } from '../calls/suppressions.service';
import { toE164 } from '../common/phone';
import { QUEUE, queueToken, type InboundMessageJobData } from '../jobs/queues';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { WebhookEventsService, dedupeKeys } from './webhook-events.service';

/**
 * Inbound SMS and delivery status.
 *
 * `/incoming` is where a caller's reply arrives — the moment a missed call becomes a
 * conversation. Two things must happen here and nowhere else:
 *
 *   1. **STOP is honoured immediately.** Twilio stops delivery at its end, but our
 *      database has to agree or every later send burns an API call to be rejected
 *      with 21610. Recorded synchronously, before anything else, because it is the
 *      one obligation with legal weight (docs/compliance.md §1).
 *   2. **The message is recorded**, so the thread and the billing picture are
 *      complete.
 *   3. **The reply is enqueued**, and nothing more. Extraction, the next question and
 *      lead creation all happen on the worker.
 *
 * That third step is the whole of rule 8 in one line: validate → persist → enqueue →
 * return. The expensive work is a model call taking seconds, and Twilio abandons a
 * webhook at around 15 — so this endpoint does the cheap, ordered part and hands over.
 */
@Controller('webhooks/twilio/messages')
@UseGuards(TwilioSignatureGuard)
export class MessagesController {
  private readonly logger = new Logger(MessagesController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookEvents: WebhookEventsService,
    private readonly suppressions: SuppressionsService,
    @Inject(queueToken(QUEUE.INBOUND_MESSAGE))
    private readonly inboundQueue: Queue<InboundMessageJobData>,
  ) {}

  /**
   * A customer replied.
   *
   * Returns empty TwiML, always. Twilio sends whatever we return as an SMS back to
   * the customer — so a stray string here is an unintended, billed message, and an
   * error page would be delivered as text. Silence is the correct response; replies
   * are sent deliberately by the worker.
   */
  @Post('incoming')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async incoming(@Body() body: Record<string, string>): Promise<string> {
    const messageSid = body.MessageSid ?? body.SmsSid ?? '';
    const from = toE164(body.From);
    const to = toE164(body.To);
    const text = body.Body ?? '';

    try {
      const outcome = await this.webhookEvents.record({
        dedupeKey: dedupeKeys.messageIncoming(messageSid),
        externalEventId: messageSid,
        eventType: 'message.incoming',
        payload: body,
      });

      if (outcome.status === 'duplicate') {
        return EMPTY_TWIML;
      }

      const number = to ? await this.findNumber(to) : null;
      if (!number || !from) {
        this.logger.warn(`Inbound SMS to unrecognised number ${to ?? body.To} — ignoring`);
        await this.webhookEvents.markIgnored(
          outcome.event.id,
          `unrecognised To: ${to ?? 'unparseable'}`,
        );
        return EMPTY_TWIML;
      }

      const businessId = number.businessId;

      // Opt-out first, before the message is even attributed to a customer. A STOP
      // must take effect even if every later step fails.
      const keyword = this.suppressions.classifyKeyword(text);
      if (keyword === 'stop') {
        await this.suppressions.optOut(businessId, from, messageSid);
      } else if (keyword === 'start') {
        await this.suppressions.optIn(businessId, from);
      }

      const customer = await this.upsertCustomer(businessId, from);

      const message = await this.prisma.db.message.create({
        data: {
          businessId,
          customerId: customer.id,
          direction: 'INBOUND',
          status: 'RECEIVED',
          fromE164: from,
          toE164: number.e164,
          body: text,
          providerMessageSid: messageSid,
          // Inbound segments are billed too, at a lower rate. Twilio reports the
          // count; falling back to 1 keeps the billing sum honest rather than zero.
          segments: Number.parseInt(body.NumSegments ?? '', 10) || 1,
        },
      });

      await this.webhookEvents.markProcessed(outcome.event.id, businessId);

      // Extraction, the next question and lead creation all happen on the worker.
      // Running any of it inline would put a multi-second model call inside a webhook
      // Twilio abandons at ~15s (rule 8).
      //
      // A STOP reply is never enqueued: replying to someone who asked us to stop is
      // the exact thing the opt-out forbids, and the cheapest way to guarantee that
      // is for the job never to exist.
      if (keyword !== 'stop') {
        await this.enqueueReply(message.id, businessId, messageSid);
      }

      return EMPTY_TWIML;
    } catch (error) {
      this.logger.error(
        `Failed to handle inbound SMS ${messageSid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Still empty TwiML — a 500 would make Twilio retry, and the customer would
      // receive nothing either way.
      return EMPTY_TWIML;
    }
  }

  /**
   * Delivery status for a message we sent.
   *
   * This is what turns `QUEUED` into `DELIVERED` or `FAILED`. Without it every
   * outbound message stays `QUEUED` forever and the dashboard would show a recovery
   * SMS as sent when it never arrived.
   */
  @Post('status')
  @HttpCode(204)
  async status(@Body() body: Record<string, string>): Promise<void> {
    const messageSid = body.MessageSid ?? body.SmsSid ?? '';
    const rawStatus = body.MessageStatus ?? body.SmsStatus ?? 'unknown';

    try {
      await this.webhookEvents.record({
        dedupeKey: dedupeKeys.messageStatus(messageSid, rawStatus),
        externalEventId: messageSid,
        eventType: 'message.status',
        payload: body,
      });

      const status = STATUS_MAP[rawStatus.toLowerCase()];
      if (!status) {
        this.logger.warn(`Unrecognised Twilio MessageStatus: ${rawStatus}`);
        return;
      }

      // Looked up unscoped because the status callback carries no tenant, and the
      // Sid is globally unique — one of the few legitimate cross-tenant reads (D8).
      const message = await this.prisma.unscoped.message.findFirst({
        where: { providerMessageSid: messageSid },
        select: { id: true, businessId: true, status: true },
      });
      if (!message) {
        this.logger.warn(`Status callback for unknown message ${messageSid}`);
        return;
      }

      // Callbacks arrive out of order. A late `sent` must not undo a `delivered`.
      if (TERMINAL.has(message.status)) return;

      const errorCode = Number.parseInt(body.ErrorCode ?? '', 10);
      await this.prisma.db.message.update({
        where: { id: message.id, businessId: message.businessId },
        data: {
          status,
          deliveredAt: status === 'DELIVERED' ? new Date() : undefined,
          errorCode: Number.isFinite(errorCode) ? errorCode : undefined,
          // Twilio prices in USD and reports it as a negative string. Stored as
          // positive integer cents AUD (rule 11) — the conversion lands with billing;
          // for now the raw figure is kept out rather than stored wrong.
        },
      });

      if (status === 'UNDELIVERED' || status === 'FAILED') {
        // A recovery SMS that never arrived is a lost lead the dashboard would
        // otherwise show as contacted.
        this.logger.warn(
          `Message ${messageSid} ${status}${body.ErrorCode ? ` (${body.ErrorCode})` : ''}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle status for ${messageSid}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Hand the reply to the worker.
   *
   * `jobId` is derived from the MessageSid — unique per inbound message — so a
   * duplicate webhook delivery that somehow gets past `webhook_events` still collapses
   * to one job. Hyphens, not colons: BullMQ rejects a colon in a custom id.
   *
   * A failure to enqueue is logged and swallowed, matching `VoiceController`. Throwing
   * would return a 500 and Twilio would retry — but the retry hits the idempotency
   * check above, returns early as a duplicate, and never reaches this line. So a throw
   * costs a retry storm and fixes nothing. The message row is already written, which
   * is what makes the job re-drivable by hand.
   *
   * This is the one failure that is silent to the customer: they replied, and nothing
   * comes back. Hence `error`, not `warn`.
   */
  private async enqueueReply(
    messageId: string,
    businessId: string,
    messageSid: string,
  ): Promise<void> {
    try {
      await this.inboundQueue.add(
        'inbound',
        { messageId, businessId },
        { jobId: `inbound-${messageSid}` },
      );
      this.logger.log(`Inbound reply ${messageSid} queued for processing`);
    } catch (error) {
      this.logger.error(
        `Failed to enqueue inbound reply ${messageSid}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Message ${messageId} is recorded and the job can be re-driven; ` +
          `until then this customer gets no response.`,
      );
    }
  }

  private async findNumber(e164: string) {
    return this.prisma.unscoped.phoneNumber.findFirst({
      where: { e164, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: { businessId: true, e164: true },
    });
  }

  private async upsertCustomer(businessId: string, phoneE164: string) {
    return this.prisma.db.customer.upsert({
      where: { businessId, businessId_phoneE164: { businessId, phoneE164 } },
      create: { businessId, phoneE164 },
      update: {},
    });
  }
}

/**
 * Twilio delivers the body of a messaging webhook response as an SMS. Returning an
 * empty `<Response/>` is how you say "no reply" — anything else is a billed message
 * the customer did not ask for.
 */
const EMPTY_TWIML = new twiml.MessagingResponse().toString();

const STATUS_MAP: Record<string, 'QUEUED' | 'SENT' | 'DELIVERED' | 'UNDELIVERED' | 'FAILED'> = {
  queued: 'QUEUED',
  accepted: 'QUEUED',
  scheduled: 'QUEUED',
  sending: 'SENT',
  sent: 'SENT',
  delivered: 'DELIVERED',
  undelivered: 'UNDELIVERED',
  failed: 'FAILED',
};

/** Once here, a later callback must not walk the message backwards. */
const TERMINAL = new Set(['DELIVERED', 'UNDELIVERED', 'FAILED']);
