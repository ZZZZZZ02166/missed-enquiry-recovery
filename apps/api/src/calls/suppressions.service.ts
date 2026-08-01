import { Injectable, Logger } from '@nestjs/common';
import type { Suppression, SuppressionReason } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Owns the answer to "may we send to this number?".
 *
 * Every outbound send passes through `isSuppressed` first. That check is the last
 * thing standing between a STOP reply and a Spam Act breach, so it is deliberately
 * boring: one indexed lookup, no caching, no cleverness.
 */

/**
 * Which reason wins when a number is already suppressed for a different one.
 *
 * The table holds one row per (business, phone), so a number blocked as SPAM that
 * later replies STOP has to resolve to something. OPTED_OUT always wins: it is the
 * only reason with legal weight, and the only one we may never quietly discard.
 * The rest are operational and can be overwritten freely.
 *
 * Higher number wins.
 */
const REASON_PRECEDENCE: Record<SuppressionReason, number> = {
  OPTED_OUT: 100,
  STAFF: 20,
  SPAM: 10,
  NOT_TEXTABLE: 5,
};

/**
 * The keywords Twilio treats as opt-out, matched case-insensitively.
 *
 * Twilio handles these itself and stops delivery at its end — but we must record
 * them too. Relying on Twilio's list alone means our own database believes the
 * number is fine, and every send attempt burns an API call to be rejected with
 * error 21610 (`.claude/skills/twilio/SKILL.md` §5).
 */
const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

/** `START` / `UNSTOP` resubscribe at Twilio's layer; we mirror that. */
const START_KEYWORDS = new Set(['start', 'unstop', 'yes']);

@Injectable()
export class SuppressionsService {
  private readonly logger = new Logger(SuppressionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The hot path. Called before every outbound send.
   *
   * Returns the reason, or null when sending is permitted. Deliberately returns the
   * reason rather than a boolean so the caller can record *why* it skipped
   * (`NoRecoveryReason`) instead of logging an unexplained no-op.
   *
   * Not cached. An opt-out must take effect on the very next send, and a stale cache
   * entry here is a compliance breach rather than a performance regression. The
   * unique index makes this an index-only scan (measured at step 29).
   */
  async isSuppressed(businessId: string, phoneE164: string): Promise<SuppressionReason | null> {
    const row = await this.prisma.db.suppression.findFirst({
      where: { businessId, phoneE164 },
      select: { reason: true },
    });
    return row?.reason ?? null;
  }

  /**
   * Suppress a number, respecting precedence.
   *
   * Never downgrades: a number already OPTED_OUT stays OPTED_OUT even if it is later
   * blocked as SPAM or found to be a landline. Silently losing an opt-out because a
   * lower-priority write happened afterwards is exactly the failure this guards.
   */
  async suppress(params: {
    businessId: string;
    phoneE164: string;
    reason: SuppressionReason;
    note?: string;
    sourceMessageSid?: string;
  }): Promise<Suppression> {
    const { businessId, phoneE164, reason } = params;

    const existing = await this.prisma.db.suppression.findFirst({
      where: { businessId, phoneE164 },
    });

    if (existing) {
      if (REASON_PRECEDENCE[existing.reason] >= REASON_PRECEDENCE[reason]) {
        // Keep the stronger reason, but still record the note and evidence if this
        // call carries them — the fact that they also opted out is worth keeping.
        if (params.note || params.sourceMessageSid) {
          return this.prisma.db.suppression.update({
            where: { id: existing.id, businessId },
            data: {
              note: params.note ?? existing.note,
              sourceMessageSid: params.sourceMessageSid ?? existing.sourceMessageSid,
            },
          });
        }
        return existing;
      }

      return this.prisma.db.suppression.update({
        where: { id: existing.id, businessId },
        data: {
          reason,
          note: params.note ?? existing.note,
          sourceMessageSid: params.sourceMessageSid ?? existing.sourceMessageSid,
        },
      });
    }

    return this.prisma.db.suppression.create({
      data: {
        businessId,
        phoneE164,
        reason,
        note: params.note,
        sourceMessageSid: params.sourceMessageSid,
      },
    });
  }

  /**
   * Record an opt-out. The Spam Act path.
   *
   * Logged at `warn` on purpose: an opt-out is not an error, but a rising rate is the
   * clearest early signal that the messaging is landing badly, and it should be
   * visible without going looking.
   */
  async optOut(
    businessId: string,
    phoneE164: string,
    sourceMessageSid?: string,
  ): Promise<Suppression> {
    this.logger.warn(`Opt-out recorded for ${phoneE164} (business ${businessId})`);
    return this.suppress({
      businessId,
      phoneE164,
      reason: 'OPTED_OUT',
      sourceMessageSid,
      note: 'Customer replied with a STOP keyword',
    });
  }

  /**
   * Undo an opt-out after START / UNSTOP.
   *
   * Only removes `OPTED_OUT` rows. A resubscribe says nothing about a landline or an
   * owner's blocklist entry, and deleting those would let a blocked marketer text
   * their way back in.
   */
  async optIn(businessId: string, phoneE164: string): Promise<boolean> {
    const { count } = await this.prisma.db.suppression.deleteMany({
      where: { businessId, phoneE164, reason: 'OPTED_OUT' },
    });
    if (count > 0) {
      this.logger.log(`Opt-in: suppression cleared for ${phoneE164} (business ${businessId})`);
    }
    return count > 0;
  }

  /**
   * Classify an inbound message body as a STOP or START keyword.
   *
   * Twilio matches the whole message, not a substring — "please stop by tomorrow"
   * must not opt someone out, and treating it as one would silently lose a customer
   * mid-conversation. Exact match after trimming and stripping trailing punctuation.
   */
  classifyKeyword(body: string): 'stop' | 'start' | null {
    const normalised = body
      .trim()
      .toLowerCase()
      .replace(/[.!?]+$/, '');
    if (STOP_KEYWORDS.has(normalised)) return 'stop';
    if (START_KEYWORDS.has(normalised)) return 'start';
    return null;
  }

  /** Owner blocklist, from the dashboard. */
  async block(businessId: string, phoneE164: string, note?: string): Promise<Suppression> {
    return this.suppress({ businessId, phoneE164, reason: 'SPAM', note });
  }

  /**
   * Cache a Twilio Lookup result that says this number cannot receive SMS.
   *
   * Written alongside `Customer.lineType`. Both hold the same fact, but this is the
   * one the send path trusts — the customer row is the cache of what Lookup said,
   * this is the decision not to send.
   */
  async markNotTextable(
    businessId: string,
    phoneE164: string,
    lineType: string,
  ): Promise<Suppression> {
    return this.suppress({
      businessId,
      phoneE164,
      reason: 'NOT_TEXTABLE',
      note: `Twilio Lookup reported line type: ${lineType}`,
    });
  }

  /** Everything suppressed for a business — the dashboard list. */
  async listForBusiness(businessId: string, reason?: SuppressionReason): Promise<Suppression[]> {
    return this.prisma.db.suppression.findMany({
      where: { businessId, ...(reason ? { reason } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }
}
