import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma, WebhookEvent } from '../generated/prisma/client';

/**
 * Records every provider delivery exactly once.
 *
 * This is the piece that makes replaying a payload three times produce one call,
 * one SMS, one lead. Twilio retries on any non-timely 200 and duplicate delivery is
 * documented behaviour, so "we received this already" has to be a first-class,
 * cheap answer rather than something inferred later.
 */

/**
 * The four dedupe-key shapes, in one place.
 *
 * `.claude/skills/twilio/SKILL.md` §3 requires each handler to own what "the same
 * event" means, because `CallSid` alone is not unique per delivery — one call emits
 * an incoming webhook plus several status callbacks that all carry it. Handlers
 * still choose *which* builder to call; centralising the strings just stops a
 * handler inventing a fifth shape or, worse, omitting the distinguishing field.
 *
 * The rule these encode: **the key must include every field that distinguishes one
 * legitimate delivery from another.** Omitting `callStatus` below would silently
 * collapse every status callback for a call into the first one.
 */
export const dedupeKeys = {
  voiceIncoming: (callSid: string) => `twilio:voice:incoming:${callSid}`,
  voiceStatus: (callSid: string, callStatus: string) =>
    `twilio:voice:status:${callSid}:${callStatus}`,
  messageIncoming: (messageSid: string) => `twilio:message:incoming:${messageSid}`,
  messageStatus: (messageSid: string, messageStatus: string) =>
    `twilio:message:status:${messageSid}:${messageStatus}`,
} as const;

export interface RecordWebhookEventInput {
  /** Built with `dedupeKeys`. Unique — this is what makes the operation idempotent. */
  dedupeKey: string;
  /** CallSid / MessageSid. Indexed but not unique: "everything about this call". */
  externalEventId: string;
  /** e.g. `voice.incoming`, `voice.status`, `message.incoming`, `message.status` */
  eventType: string;
  /** Verbatim provider params. Personal information — 90-day retention. */
  payload: Record<string, unknown>;
  /** Usually null at record time; the tenant is resolved afterwards. */
  businessId?: string | null;
}

export type RecordOutcome =
  { status: 'recorded'; event: WebhookEvent } | { status: 'duplicate'; dedupeKey: string };

/** The `error` column is for triage, not for stack traces (see schema.prisma). */
const MAX_ERROR_LENGTH = 500;

@Injectable()
export class WebhookEventsService {
  private readonly logger = new Logger(WebhookEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a delivery, or report that we have already seen it.
   *
   * Uses `createManyAndReturn` with `skipDuplicates` rather than catching a P2002
   * unique violation. Two reasons: the decision is made atomically by the database
   * in a single round trip, with no window between a "does it exist" check and the
   * insert; and it keeps duplicates off the exception path, which matters because a
   * duplicate is *normal traffic* here, not an error. An empty result means the
   * unique index rejected the row — i.e. we have seen this exact delivery before.
   */
  async record(input: RecordWebhookEventInput): Promise<RecordOutcome> {
    const rows = await this.prisma.db.webhookEvent.createManyAndReturn({
      data: [
        {
          provider: 'TWILIO',
          dedupeKey: input.dedupeKey,
          externalEventId: input.externalEventId,
          eventType: input.eventType,
          payload: input.payload as Prisma.InputJsonValue,
          // Only validly-signed requests reach this service — the guard rejects the
          // rest before any side effect. Stored as a column rather than assumed so
          // that a future rate-limited path can record failures too.
          signatureValid: true,
          businessId: input.businessId ?? null,
        },
      ],
      skipDuplicates: true,
    });

    const event = rows[0];
    if (!event) {
      // Expected and frequent. Debug, not warn — a Twilio retry is not a problem.
      this.logger.debug(`Duplicate delivery ignored: ${input.dedupeKey}`);
      return { status: 'duplicate', dedupeKey: input.dedupeKey };
    }

    return { status: 'recorded', event };
  }

  /** Tenant resolved and work completed. */
  async markProcessed(id: string, businessId?: string | null): Promise<void> {
    await this.prisma.db.webhookEvent.update({
      where: { id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        ...(businessId ? { businessId } : {}),
      },
    });
  }

  /**
   * Recognised, deliberately not acted on — a spam caller, a suppressed number, a
   * status transition we do not care about. Distinct from FAILED so that a rising
   * failure count keeps meaning something is broken.
   */
  async markIgnored(id: string, reason: string, businessId?: string | null): Promise<void> {
    await this.prisma.db.webhookEvent.update({
      where: { id },
      data: {
        status: 'IGNORED',
        processedAt: new Date(),
        error: truncate(reason),
        ...(businessId ? { businessId } : {}),
      },
    });
  }

  /**
   * Processing failed. Increments `attempts` so a row that keeps failing is visible
   * as such rather than looking like a single stuck event.
   *
   * Takes `businessId` for the same reason the other two do: a failed event is the
   * one an operator most needs to attribute to a tenant, and leaving it null made
   * failures invisible to any per-business query.
   */
  async markFailed(id: string, reason: string, businessId?: string | null): Promise<void> {
    await this.prisma.db.webhookEvent.update({
      where: { id },
      data: {
        status: 'FAILED',
        error: truncate(reason),
        attempts: { increment: 1 },
        ...(businessId ? { businessId } : {}),
      },
    });
  }

  /**
   * Retention sweep — 90 days (docs/compliance.md §7). This table holds caller phone
   * numbers and message text and has no value beyond idempotency once the provider
   * has stopped retrying.
   *
   * The scheduled job that calls this lands with the maintenance queue; the method
   * exists now so the obligation is implemented rather than remembered.
   */
  async deleteOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.db.webhookEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`Retention sweep removed ${count} webhook_events older than ${days}d`);
    }
    return count;
  }
}

function truncate(value: string, max: number = MAX_ERROR_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
