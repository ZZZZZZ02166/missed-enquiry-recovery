import { Injectable, Logger } from '@nestjs/common';
import { WebhookEventsService } from '../../telephony/webhook-events.service';

/**
 * The retention sweep.
 *
 * Implements the schedule in `docs/compliance.md` §7. Retention is an obligation
 * rather than housekeeping: holding caller phone numbers and message text longer than
 * stated is the kind of thing that is invisible until somebody asks, and then is not
 * defensible. A written policy nothing enforces is worse than no policy, because it
 * documents the breach.
 *
 * **Only `webhook_events` is swept today, and that is deliberate** — see the note at
 * the bottom of this file. The others are dated in the policy but not yet safe to
 * delete, and deleting them wrongly is far worse than deleting them late.
 */

/**
 * Webhook events: 90 days (`docs/compliance.md` §7).
 *
 * They exist for idempotency and have no value once the provider has long stopped
 * retrying — while holding a verbatim copy of every caller's number and every message
 * body. The highest-value deletion in the table, and the one with no dependants.
 */
const WEBHOOK_EVENT_DAYS = 90;

@Injectable()
export class RetentionProcessor {
  private readonly logger = new Logger(RetentionProcessor.name);

  constructor(private readonly webhookEvents: WebhookEventsService) {}

  async process(): Promise<void> {
    const removed = await this.webhookEvents.deleteOlderThan(WEBHOOK_EVENT_DAYS);

    // Logged even at zero, once a day. A retention sweep that silently stops running
    // looks exactly like one that has nothing to delete, and the difference only
    // becomes visible during an audit.
    this.logger.log(
      `Retention sweep complete: ${removed} webhook_events older than ${WEBHOOK_EVENT_DAYS}d removed`,
    );
  }
}

/**
 * Why the other rows in the policy are not swept here yet.
 *
 * **Suppressions are never deleted, and that is the point.** `docs/compliance.md` §7
 * marks them indefinite deliberately: deleting an opt-out re-enables messaging someone
 * who said stop. They must never appear in a sweep, which is why this file names them
 * rather than leaving their absence to be read as an oversight.
 *
 * **Messages, conversations and calls (24 months) are blocked on a genuine conflict,
 * not on effort.** `Lead` has `onDelete: Cascade` on its conversation, and leads are
 * retained for *longer* than conversations — the life of the account plus 12 months.
 * Deleting a 24-month-old conversation would therefore silently take a lead the policy
 * says to keep. Resolving that needs either a nulled relation, a lead-aware predicate,
 * or an archive step, and picking one on the way past would be guessing.
 *
 * Nothing in this system is near 24 months old, so the cost of waiting is zero and the
 * cost of getting the cascade wrong is a permanently missing owner record.
 *
 * **Attachments (12 months)** have no table yet.
 */
