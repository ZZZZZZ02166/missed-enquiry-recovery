import { Injectable, Logger } from '@nestjs/common';
import type { Suppression, SuppressionReason } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Owns the answer to "may we send to this number?".
 *
 * Every outbound send passes through `isSuppressed` first. That check is the last
 * thing standing between a STOP reply and a Spam Act breach, so it is deliberately
 * boring: one indexed lookup, no caching, no cleverness.
 *
 * A row carries two independent facts:
 *
 *   optedOutAt  the customer said STOP — legal, and only they can undo it
 *   reason      an operational block — NOT_TEXTABLE, SPAM, STAFF
 *
 * They were one column until step 32. Merging them meant an opt-out overwrote a
 * block, and the subsequent START deleted the row entirely — a blocked marketer
 * could text their way back in. Keeping them orthogonal removes the whole class of
 * bug: clearing one cannot touch the other.
 */

/** What `isSuppressed` reports. `OPTED_OUT` is a status, not a stored reason. */
export type SuppressionStatus = SuppressionReason | 'OPTED_OUT';

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
   * Returns the reason, or null when sending is permitted. Deliberately returns a
   * reason rather than a boolean so the caller can record *why* it skipped
   * (`NoRecoveryReason`) instead of logging an unexplained no-op.
   *
   * `OPTED_OUT` outranks any operational reason in what it *reports* — it is the
   * answer that matters legally, and the one an owner needs to see. The block
   * underneath is still on the row, so removing the opt-out does not unblock.
   *
   * Not cached. An opt-out must take effect on the very next send, and a stale entry
   * here is a compliance breach rather than a performance regression. The unique
   * index makes this an index-only scan (measured at step 29).
   */
  async isSuppressed(businessId: string, phoneE164: string): Promise<SuppressionStatus | null> {
    const row = await this.prisma.db.suppression.findFirst({
      where: { businessId, phoneE164 },
      select: { reason: true, optedOutAt: true },
    });
    if (!row) return null;
    if (row.optedOutAt) return 'OPTED_OUT';
    return row.reason;
  }

  /**
   * Apply an operational block, leaving any opt-out untouched.
   *
   * No precedence logic is needed any more. The two facts live in different columns,
   * so writing one cannot destroy the other — which is exactly the bug that made
   * precedence necessary in the first place.
   */
  async suppress(params: {
    businessId: string;
    phoneE164: string;
    reason: SuppressionReason;
    note?: string;
  }): Promise<Suppression> {
    const { businessId, phoneE164, reason, note } = params;

    const existing = await this.prisma.db.suppression.findFirst({
      where: { businessId, phoneE164 },
    });

    if (existing) {
      return this.prisma.db.suppression.update({
        where: { id: existing.id, businessId },
        data: { reason, note: note ?? existing.note },
      });
    }

    return this.prisma.db.suppression.create({
      data: { businessId, phoneE164, reason, note },
    });
  }

  /**
   * Record an opt-out. The Spam Act path.
   *
   * Sets `optedOutAt` and nothing else, so an existing block survives. Re-recording
   * an opt-out keeps the *original* timestamp: the date that matters is when they
   * first said stop, not when they last repeated it.
   *
   * Logged at `warn` on purpose. An opt-out is not an error, but a rising rate is the
   * clearest early signal that the messaging is landing badly, and it should be
   * visible without going looking.
   */
  async optOut(
    businessId: string,
    phoneE164: string,
    sourceMessageSid?: string,
  ): Promise<Suppression> {
    this.logger.warn(`Opt-out recorded for ${phoneE164} (business ${businessId})`);

    const existing = await this.prisma.db.suppression.findFirst({
      where: { businessId, phoneE164 },
    });

    if (existing) {
      return this.prisma.db.suppression.update({
        where: { id: existing.id, businessId },
        data: {
          optedOutAt: existing.optedOutAt ?? new Date(),
          sourceMessageSid: sourceMessageSid ?? existing.sourceMessageSid,
        },
      });
    }

    return this.prisma.db.suppression.create({
      data: {
        businessId,
        phoneE164,
        // No operational reason: the row exists purely because they opted out.
        reason: null,
        optedOutAt: new Date(),
        sourceMessageSid,
        note: 'Customer replied with a STOP keyword',
      },
    });
  }

  /**
   * Undo an opt-out after START / UNSTOP.
   *
   * Clears `optedOutAt` only. An operational block stays, so a marketer the owner
   * blocked cannot text STOP then START to become contactable again — the failure
   * found at step 31.
   *
   * The row is deleted only when nothing is left to record. Keeping an empty row
   * would suppress nothing while looking like it suppressed something.
   */
  async optIn(businessId: string, phoneE164: string): Promise<boolean> {
    const existing = await this.prisma.db.suppression.findFirst({
      where: { businessId, phoneE164 },
    });
    if (!existing?.optedOutAt) return false;

    if (existing.reason === null) {
      await this.prisma.db.suppression.deleteMany({ where: { businessId, id: existing.id } });
    } else {
      await this.prisma.db.suppression.update({
        where: { id: existing.id, businessId },
        // sourceMessageSid is kept: it is evidence of the opt-out that happened,
        // and a later opt-in does not make that untrue.
        data: { optedOutAt: null },
      });
    }

    this.logger.log(`Opt-in: opt-out cleared for ${phoneE164} (business ${businessId})`);
    return true;
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
   * one the send path trusts — the customer row caches what Lookup said, this is the
   * decision not to send.
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

  /** Every opt-out for a business, newest first — the compliance view. */
  async listOptOuts(businessId: string): Promise<Suppression[]> {
    return this.prisma.db.suppression.findMany({
      where: { businessId, optedOutAt: { not: null } },
      orderBy: { optedOutAt: 'desc' },
    });
  }
}
