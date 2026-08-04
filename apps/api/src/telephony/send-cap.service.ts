import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The spend circuit breaker.
 *
 * Counts **messages actually sent**, not calls received. That distinction is the
 * whole point of this file: the cap used to live in `decideRecovery`, where it
 * counted calls that had a recovery queued — but one recovered call becomes a whole
 * conversation. Recovery, up to `MAX_QUESTIONS` questions, then a handoff: seven
 * messages from one call. A business configured for "200 SMS per day" could send
 * roughly 1,400, which is not a cap so much as a suggestion.
 *
 * Checked at **send time in the worker**, not at decision time. A job can sit in the
 * queue while other sends drain the allowance, and after an outage the reconciler
 * releases a backlog in batches — precisely the moment a ceiling has to hold.
 */

/**
 * A rolling window, not a calendar day.
 *
 * Deliberate. A midnight reset lets a runaway send its full allowance at 23:59 and
 * again at 00:01 — double the intended ceiling in two minutes, which is exactly the
 * shape of the failure this guards. A rolling window also sidesteps rule 12 entirely:
 * there is no day boundary to get wrong in the business's timezone, and no DST edge
 * twice a year.
 */
const WINDOW_HOURS = 24;

export type CapDecision =
  | { allowed: true }
  | { allowed: false; reason: 'BUSINESS_DAILY_CAP' | 'SENDING_DISABLED'; detail: string };

@Injectable()
export class SendCapService {
  private readonly logger = new Logger(SendCapService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * May this business send one more message right now?
   *
   * Call this **before** anything expensive — extraction in particular. A capped
   * conversation that has already paid for a model call has spent money to learn it
   * was not allowed to spend money.
   */
  async check(businessId: string): Promise<CapDecision> {
    if (!env.SENDING_ENABLED) {
      return {
        allowed: false,
        reason: 'SENDING_DISABLED',
        detail: 'the global kill switch is off',
      };
    }

    const sent = await this.sentInWindow(businessId);
    if (sent >= env.MAX_SMS_PER_BUSINESS_PER_DAY) {
      // Warn, not log. Hitting this is either a genuinely exceptional day or a
      // runaway loop, and both want a person to look — the whole reason the breaker
      // exists is that nobody notices spend until the invoice arrives.
      this.logger.warn(
        `Business ${businessId} has sent ${sent} messages in ${WINDOW_HOURS}h and hit the ` +
          `cap of ${env.MAX_SMS_PER_BUSINESS_PER_DAY}. Further sends are blocked until the ` +
          'window rolls. If this is legitimate volume, raise MAX_SMS_PER_BUSINESS_PER_DAY.',
      );
      return {
        allowed: false,
        reason: 'BUSINESS_DAILY_CAP',
        // Names the limit, not just the numbers. This string is persisted on the
        // message row, and "23/20 messages in 24h" leaves the next reader guessing
        // which of several guards stopped it.
        detail: `daily send cap reached: ${sent}/${env.MAX_SMS_PER_BUSINESS_PER_DAY} messages in ${WINDOW_HOURS}h`,
      };
    }

    return { allowed: true };
  }

  /**
   * Outbound messages for this business in the window.
   *
   * Counts failed sends too. Twilio bills a processing fee on a rejected message, and
   * a loop that fails every time is exactly the runaway this is meant to stop — not
   * counting failures would make the breaker useless in the case it matters most.
   *
   * Owner notifications are included as well: they cost the same and come from the
   * same budget.
   */
  async sentInWindow(businessId: string): Promise<number> {
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
    return this.prisma.db.message.count({
      where: { businessId, direction: 'OUTBOUND', createdAt: { gte: since } },
    });
  }
}
