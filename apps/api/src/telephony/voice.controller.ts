import { Body, Controller, Header, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { twiml } from 'twilio';
import { CallsService } from '../calls/calls.service';
import { toE164 } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { WebhookEventsService, dedupeKeys } from './webhook-events.service';

/**
 * Inbound voice webhooks.
 *
 * The forwarded-call path (D1): the caller rings the business, their carrier
 * forwards the unanswered call here, Twilio POSTs to `/incoming`, we answer, say one
 * line, and hang up (D2).
 *
 * Contract, in order: validate → persist → enqueue → return
 * (`.claude/skills/twilio/SKILL.md` §3). Twilio times out around 15 seconds, and
 * nothing in here may send an SMS or call an LLM — those belong to the worker, which
 * lands with the queue. Right now the "enqueue" step is a marked gap rather than a
 * silent omission.
 */
@Controller('webhooks/twilio/voice')
@UseGuards(TwilioSignatureGuard)
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookEvents: WebhookEventsService,
    private readonly calls: CallsService,
  ) {}

  /**
   * A forwarded call has arrived.
   *
   * Always returns 200 with valid TwiML — including when recording fails. A 500 here
   * makes the caller hear a Twilio error tone during precisely the window this
   * product exists to fix, and Twilio would retry, so the failure is both audible and
   * repeated. Losing a row is bad; a bad caller experience is worse.
   */
  @Post('incoming')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async incoming(@Body() body: Record<string, string>): Promise<string> {
    const callSid = body.CallSid ?? '';
    const to = toE164(body.To);
    const from = toE164(body.From);

    try {
      const outcome = await this.webhookEvents.record({
        dedupeKey: dedupeKeys.voiceIncoming(callSid),
        externalEventId: callSid,
        eventType: 'voice.incoming',
        payload: body,
      });

      if (outcome.status === 'duplicate') {
        // A Twilio retry. The first delivery already did the work; still answer with
        // the same TwiML, because this delivery is a live call leg of its own.
        return this.greeting(await this.businessNameFor(to));
      }

      const number = to ? await this.findNumber(to) : null;

      if (!number) {
        // Unrecognised `To`. Either a released number still being dialled, or a
        // misconfigured console entry. IGNORED, not FAILED — nothing is broken here,
        // and conflating them would make the failure count useless as an alert.
        this.logger.warn(`Inbound call to unrecognised number: ${to ?? body.To}`);
        await this.webhookEvents.markIgnored(
          outcome.event.id,
          `unrecognised To: ${to ?? 'unparseable'}`,
        );
        return this.greeting(null);
      }

      await this.webhookEvents.markProcessed(outcome.event.id, number.businessId);

      // Record the call and decide whether to recover. `from` is null for a withheld
      // caller ID — a normal daily occurrence, not an error — and CallsService
      // handles that itself, returning ANONYMOUS_CALLER. Passing it through rather
      // than branching here keeps every "why we did not text" answer in one place.
      const decision = await this.calls.recordInboundCall({
        businessId: number.businessId,
        providerCallSid: callSid,
        fromE164: from,
        // The stored number, not the inbound `To`. Both normalise to the same value —
        // we just looked the row up by it — but this one is canonical by construction
        // and needs no fallback for an unparseable input.
        toE164: number.e164,
        // Inconsistently populated on AU PSTN and never depended on, but every real
        // call is evidence for the D13 question of what carriers actually pass on.
        forwardedFromE164: toE164(body.ForwardedFrom),
        callStatus: body.CallStatus,
      });

      if (decision.shouldRecover) {
        // GAP (deliberate, not forgotten): the recovery SMS is enqueued here once the
        // queue exists. It must never be sent inside this request — Twilio's ~15s
        // timeout and the no-side-effects-in-a-webhook rule both forbid it. The call
        // is already marked `recoverySmsQueuedAt`, so the decision survives a crash
        // between here and the enqueue.
        this.logger.log(`Call ${callSid}: recovery pending (queue not yet built)`);
      }

      return this.greeting(number.business.name);
    } catch (error) {
      // Answer anyway. See the method comment.
      this.logger.error(
        `Failed to record inbound call ${callSid}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.greeting(null);
    }
  }

  /**
   * Call status callbacks (`completed`, `no-answer`, `busy`, `failed`).
   *
   * Recorded rather than acted on for now. Each status gets its own dedupe key, so
   * every transition is kept and the true ordering is recoverable — callbacks arrive
   * out of order.
   */
  @Post('status')
  @HttpCode(204)
  async status(@Body() body: Record<string, string>): Promise<void> {
    const callSid = body.CallSid ?? '';
    const callStatus = body.CallStatus ?? 'unknown';

    try {
      await this.webhookEvents.record({
        dedupeKey: dedupeKeys.voiceStatus(callSid, callStatus),
        externalEventId: callSid,
        eventType: 'voice.status',
        payload: body,
      });

      // Apply the outcome even for a duplicate delivery: the write is idempotent and
      // guards terminal states, so a replay cannot walk a completed call backwards.
      const to = toE164(body.To);
      const number = to ? await this.findNumber(to) : null;
      if (number) {
        const duration = Number.parseInt(body.CallDuration ?? '', 10);
        await this.calls.applyStatus(
          number.businessId,
          callSid,
          callStatus,
          Number.isFinite(duration) ? duration : undefined,
        );
      }
    } catch (error) {
      // A status callback carries no caller-facing consequence, so swallowing it is
      // safe — but it must still not 500, or Twilio retries a request we cannot serve.
      this.logger.error(
        `Failed to record call status ${callSid}/${callStatus}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Resolve the tenant from the dialled number. */
  private async findNumber(e164: string) {
    // One of the few legitimate uses of `unscoped` (D8): this lookup *is* how the
    // tenant is discovered, so there is no businessId to scope by yet.
    return this.prisma.unscoped.phoneNumber.findFirst({
      where: { e164, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      include: { business: { select: { name: true } } },
    });
  }

  /** Business name for a duplicate delivery, where we skip the full lookup path. */
  private async businessNameFor(e164: string | null): Promise<string | null> {
    if (!e164) return null;
    const number = await this.findNumber(e164);
    return number?.business.name ?? null;
  }

  /**
   * Answer, announce the text, hang up (D2).
   *
   * No `<Record>` and no voicemail, ever — recording drags in consent, storage,
   * retention and disclosure obligations we deliberately avoided.
   *
   * The greeting names the business and says a text is coming. Both matter: it is
   * the caller's only signal that an SMS about to arrive from an unknown number is
   * legitimate, and it is expected to move reply rate more than any copy change.
   *
   * `name` is null when the business is unknown — an unrecognised number, or a
   * failure. The wording then stays generic rather than guessing.
   */
  private greeting(name: string | null): string {
    const response = new twiml.VoiceResponse();
    const who = name ? `to ${name}` : '';

    response.say(
      { voice: 'Polly.Nicole', language: 'en-AU' },
      name
        ? `Thanks for calling ${name}. Sorry we can't take your call right now. We're sending you a text message so we can help.`
        : `Sorry, we can't take your call right now. We're sending you a text message so we can help.`,
    );
    response.hangup();

    this.logger.debug(`Answered call ${who}`.trim());
    return response.toString();
  }
}
