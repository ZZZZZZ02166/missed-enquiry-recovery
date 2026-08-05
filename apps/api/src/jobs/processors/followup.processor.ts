import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SuppressionsService } from '../../calls/suppressions.service';
import { env } from '../../config/env';
import { prepareBusinessName, recoveryNudgeMessage } from '../../notifications/templates';
import { PrismaService } from '../../prisma/prisma.service';
import { SendCapService } from '../../telephony/send-cap.service';
import { PermanentSendError, SMS_PROVIDER, type SmsProvider } from '../../telephony/sms.provider';
import { QUEUE, addJobBounded, queueToken, type FollowupJobData } from '../queues';

/**
 * Closes conversations that stopped.
 *
 * Without this, `AWAITING_FIRST_REPLY` and `COLLECTING` have no exit: a customer who
 * never replies leaves a conversation open forever, so "open conversations" is not a
 * number anyone can trust and the owner's inbox slowly fills with threads nobody is
 * waiting on. Plan item A6.
 *
 * Two actions, and they are deliberately different in kind:
 *
 *   **nudge**   one message, ever, and off unless the owner turns it on. A second
 *               nudge to someone who ignored the first is the point at which a
 *               transactional reply starts to look like marketing, which is exactly
 *               what rule 10 keeps these messages away from.
 *   **expire**  no message at all. State only.
 *
 * Driven by a periodic sweep over Postgres rather than delayed BullMQ jobs. Postgres
 * is the source of truth for when a conversation went quiet, a delayed job would have
 * to be cancelled every time the customer replies, and a Redis flush would silently
 * drop every pending nudge — the failure `appendonly=yes` exists to prevent, which is
 * a poor thing to depend on when a plain query answers the question.
 */

/** No reply for this long and the conversation is over. */
const EXPIRE_AFTER_HOURS = 48;

/** Bounded like every other sweep: a backlog drains at a pace, not in a burst. */
const BATCH_SIZE = 100;

/**
 * The window in which a nudge may be sent, in the business's own timezone.
 *
 * Rule 12: never server local time. A nudge at 3am is worse than no nudge — it wakes
 * someone up on behalf of a business they had already decided not to use.
 *
 * A blunt window rather than `businesses.hours`, deliberately: that column is
 * unstructured JSON with no writer yet, and inventing a shape here would be guessing
 * at one the settings screen has to agree with. This is the conservative subset —
 * anything `businesses.hours` eventually says will be *narrower* than 8am-8pm.
 */
const NUDGE_EARLIEST_HOUR = 8;
const NUDGE_LATEST_HOUR = 20;

/** `automationConfig.nudgeAfterHours`. Absent or invalid means nudging is off. */
export function nudgeAfterHours(automationConfig: unknown): number | null {
  if (typeof automationConfig !== 'object' || automationConfig === null) return null;
  const value = (automationConfig as Record<string, unknown>).nudgeAfterHours;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  // A nudge after the conversation has already expired is not a nudge.
  return Math.min(value, EXPIRE_AFTER_HOURS);
}

/**
 * The hour of day at `now` in the given IANA zone.
 *
 * Uses `Intl` rather than date arithmetic so DST is the platform's problem rather
 * than ours — the bug rule 12 exists to prevent is exactly the hand-rolled offset
 * that is correct for half the year.
 */
export function hourInTimezone(now: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat('en-AU', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    return Number.parseInt(formatted, 10);
  } catch {
    // An invalid timezone must not stop the sweep. Returning an out-of-window hour
    // fails closed: no nudge is sent, rather than one sent at the wrong time.
    return -1;
  }
}

export function withinNudgeHours(now: Date, timezone: string): boolean {
  const hour = hourInTimezone(now, timezone);
  return hour >= NUDGE_EARLIEST_HOUR && hour < NUDGE_LATEST_HOUR;
}

@Injectable()
export class FollowupProcessor {
  private readonly logger = new Logger(FollowupProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppressions: SuppressionsService,
    private readonly sendCap: SendCapService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(queueToken(QUEUE.FOLLOWUP))
    private readonly followupQueue: Queue<FollowupJobData>,
  ) {}

  /**
   * Find conversations that have gone quiet and queue an action for each.
   *
   * Runs on the maintenance schedule. Enqueues rather than acting inline so each send
   * gets the retry policy and the outbound rate limiter, and so one failing
   * conversation cannot stall the sweep.
   *
   * `unscoped` because this asks a system-wide question — "has anything gone quiet?" —
   * not one on behalf of a tenant. Every write below is scoped by the `businessId`
   * read from the row (D8).
   */
  async sweep(): Promise<void> {
    const now = Date.now();
    const expireCutoff = new Date(now - EXPIRE_AFTER_HOURS * 60 * 60 * 1000);

    // Expiry first: a conversation past the 48-hour mark is finished, and nudging it
    // on the way out would be a message sent to someone we are about to give up on.
    const stale = await this.prisma.unscoped.conversation.findMany({
      where: {
        state: { in: ['AWAITING_FIRST_REPLY', 'COLLECTING'] },
        // A conversation that never got a reply has no `lastInboundAt`, so the clock
        // runs from when it was created instead.
        OR: [
          { lastInboundAt: { lt: expireCutoff } },
          { lastInboundAt: null, createdAt: { lt: expireCutoff } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, businessId: true },
    });

    for (const conversation of stale) {
      await this.enqueue(conversation.id, conversation.businessId, 'expire');
    }

    // Nudges, only for businesses that have opted in. The config lives on the
    // business, so the candidates are filtered per business rather than globally.
    // Filtered in code rather than SQL: `nudgeAfterHours` is one key inside an
    // unstructured JSON column, and a JSON-path predicate here would encode a shape
    // the settings screen has not agreed to yet. The row count is one per business.
    const nudgeable = await this.prisma.unscoped.business.findMany({
      select: { id: true, timezone: true, automationConfig: true },
    });

    for (const business of nudgeable) {
      const hours = nudgeAfterHours(business.automationConfig);
      if (hours === null) continue;
      if (!withinNudgeHours(new Date(now), business.timezone)) continue;

      const nudgeCutoff = new Date(now - hours * 60 * 60 * 1000);
      const quiet = await this.prisma.db.conversation.findMany({
        where: {
          businessId: business.id,
          state: { in: ['AWAITING_FIRST_REPLY', 'COLLECTING'] },
          // One nudge, ever.
          nudgedAt: null,
          OR: [
            { lastInboundAt: { lt: nudgeCutoff, gte: expireCutoff } },
            { lastInboundAt: null, createdAt: { lt: nudgeCutoff, gte: expireCutoff } },
          ],
        },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_SIZE,
        select: { id: true },
      });

      for (const conversation of quiet) {
        await this.enqueue(conversation.id, business.id, 'nudge');
      }
    }
  }

  async process(data: FollowupJobData): Promise<void> {
    const { conversationId, businessId, kind } = data;

    const conversation = await this.prisma.db.conversation.findFirst({
      where: { businessId, id: conversationId },
      include: {
        business: { select: { name: true, timezone: true, automationConfig: true } },
        customer: { select: { id: true, phoneE164: true } },
      },
    });

    if (!conversation) {
      this.logger.warn(`Followup for unknown conversation ${conversationId} — dropping`);
      return;
    }

    // **Every condition that made this eligible is re-derived here**, not trusted from
    // the sweep. The state check alone is not enough and that gap was a real bug: a
    // customer replying does not change the state — it stays COLLECTING — it only moves
    // `lastInboundAt`. Guarding on state alone would expire a conversation that had just
    // come back to life, telling an active customer they had been given up on.
    if (conversation.state !== 'AWAITING_FIRST_REPLY' && conversation.state !== 'COLLECTING') {
      this.logger.debug(`Conversation ${conversationId} is ${conversation.state} — nothing to do`);
      return;
    }

    const now = Date.now();
    // A conversation that never got a reply has no `lastInboundAt`; the clock runs from
    // when it was created instead.
    const lastActivity = conversation.lastInboundAt ?? conversation.createdAt;

    if (kind === 'expire') {
      if (lastActivity.getTime() >= now - EXPIRE_AFTER_HOURS * 60 * 60 * 1000) {
        this.logger.debug(`Conversation ${conversationId} has activity since the sweep — not expiring`);
        return;
      }
      await this.expire(conversation.id, businessId);
      return;
    }

    // One nudge, ever. Checked before sending, not only before marking — the marker
    // was already guarded, but nothing stopped a second job from sending a second
    // message first.
    if (conversation.nudgedAt) {
      this.logger.debug(`Conversation ${conversationId} was already nudged — skipping`);
      return;
    }

    const hours = nudgeAfterHours(conversation.business.automationConfig);
    if (hours === null) {
      // Turned off between the sweep and now.
      this.logger.debug(`Nudging is disabled for business ${businessId} — skipping`);
      return;
    }
    if (lastActivity.getTime() >= now - hours * 60 * 60 * 1000) {
      this.logger.debug(`Conversation ${conversationId} has activity since the sweep — not nudging`);
      return;
    }
    if (!withinNudgeHours(new Date(now), conversation.business.timezone)) {
      // The window closed while the job waited. Left unmarked so tomorrow's sweep
      // finds it, rather than spending the single nudge at a bad hour.
      this.logger.debug(`Outside nudge hours for business ${businessId} — deferring`);
      return;
    }

    await this.nudge(conversation.id, businessId, conversation.business.name, conversation.customer);
  }

  /**
   * Close a conversation nobody replied to.
   *
   * No message is sent. `EXPIRED` is not final in the way `OPTED_OUT` is — the state
   * machine reopens it if the customer ever texts again, and their earlier answers are
   * still there.
   */
  private async expire(conversationId: string, businessId: string): Promise<void> {
    const { count } = await this.prisma.db.conversation.updateMany({
      // Conditional so a reply that landed between the sweep and now is not discarded.
      where: {
        id: conversationId,
        businessId,
        state: { in: ['AWAITING_FIRST_REPLY', 'COLLECTING'] },
      },
      data: { state: 'EXPIRED' },
    });
    if (count === 0) return;

    // An unfinished lead becomes LOST with a reason. A *qualified* one does not: the
    // owner already has it and the customer going quiet afterwards is the owner's
    // business, not ours to write off.
    await this.prisma.db.lead.updateMany({
      where: { conversationId, businessId, status: { in: ['NEW', 'QUALIFYING'] } },
      data: { status: 'LOST', lostReason: 'no_response', closedAt: new Date() },
    });

    this.logger.log(`Conversation ${conversationId} expired after ${EXPIRE_AFTER_HOURS}h of silence`);
  }

  /**
   * Send the single nudge.
   *
   * `nudgedAt` is written **after** the send (rule 13) — a marker written first would
   * make a transient Twilio failure permanent silence, which is precisely the bug
   * step 76 fixed in the inbound path.
   */
  private async nudge(
    conversationId: string,
    businessId: string,
    businessName: string,
    customer: { id: string; phoneE164: string },
  ): Promise<void> {
    if (!env.SENDING_ENABLED) return;

    const suppressed = await this.suppressions.isSuppressed(businessId, customer.phoneE164);
    if (suppressed) {
      this.logger.log(`Not nudging ${customer.phoneE164}: ${suppressed}`);
      // Marked so the sweep stops reconsidering it every cycle.
      await this.markNudged(conversationId, businessId);
      return;
    }

    const cap = await this.sendCap.check(businessId);
    if (!cap.allowed) {
      // Left unmarked: a nudge is worth sending late, and the sweep will find it again
      // once the window rolls. It cannot loop forever — expiry closes the conversation
      // at 48 hours regardless.
      this.logger.warn(`Not nudging conversation ${conversationId} — ${cap.detail}`);
      return;
    }

    const from = await this.smsNumberFor(businessId);
    if (!from) {
      throw new Error(`Business ${businessId} has no ACTIVE SMS number; cannot nudge`);
    }

    const body = recoveryNudgeMessage(prepareBusinessName(businessName));

    try {
      const result = await this.sms.sendSms({
        to: customer.phoneE164,
        from,
        body,
        statusCallbackUrl: `${env.PUBLIC_API_URL}/webhooks/twilio/messages/status`,
      });

      await this.prisma.db.message.create({
        data: {
          businessId,
          customerId: customer.id,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          purpose: 'NUDGE',
          fromE164: from,
          toE164: customer.phoneE164,
          body,
          providerMessageSid: result.providerMessageSid,
          segments: result.segments,
          sentAt: new Date(),
        },
      });

      await this.markNudged(conversationId, businessId);
      this.logger.log(`Nudged conversation ${conversationId}`);
    } catch (error) {
      if (error instanceof PermanentSendError) {
        this.logger.warn(`Permanent failure nudging ${customer.phoneE164}: ${error.message}`);
        if (error.code === 21610) await this.suppressions.optOut(businessId, customer.phoneE164);
        // Marked: it will fail identically next time, and one nudge was the budget.
        await this.markNudged(conversationId, businessId);
        return;
      }
      // Transient: `nudgedAt` is still null, so the retry sends it.
      throw error;
    }
  }

  private async markNudged(conversationId: string, businessId: string): Promise<void> {
    await this.prisma.db.conversation.updateMany({
      where: { id: conversationId, businessId, nudgedAt: null },
      data: { nudgedAt: new Date() },
    });
  }

  private async enqueue(
    conversationId: string,
    businessId: string,
    kind: 'nudge' | 'expire',
  ): Promise<void> {
    try {
      // Deterministic id, so a conversation appearing in two consecutive sweeps
      // collapses to one job rather than two messages.
      await addJobBounded(
        this.followupQueue,
        kind,
        { conversationId, businessId, kind },
        { jobId: `followup-${kind}-${conversationId}` },
      );
    } catch (error) {
      this.logger.error(
        `Could not queue ${kind} for conversation ${conversationId}: ` +
          `${error instanceof Error ? error.message : String(error)}. The next sweep retries.`,
      );
    }
  }

  private async smsNumberFor(businessId: string): Promise<string | null> {
    const number = await this.prisma.db.phoneNumber.findFirst({
      where: { businessId, purpose: 'SMS_TWO_WAY', status: 'ACTIVE' },
      select: { e164: true },
    });
    return number?.e164 ?? null;
  }
}
