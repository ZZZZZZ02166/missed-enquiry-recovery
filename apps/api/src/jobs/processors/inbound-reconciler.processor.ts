import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SuppressionsService } from '../../calls/suppressions.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  QUEUE,
  addJobBounded,
  queueToken,
  type InboundMessageJobData,
  type RecoveryJobData,
} from '../queues';

/**
 * Re-drives inbound replies that were stored but never queued.
 *
 * This is the second half of the outbox. `messages` is the outbox table — the row is
 * written in the same request that must enqueue the job, so a reply can never be
 * enqueued without also being durable. This processor is the relay: it finds rows
 * Redis never accepted and hands them over once it can.
 *
 * Without it, a Redis blip during a webhook silently loses that customer forever: the
 * enqueue fails, Twilio has already had its 200, and its retry would be rejected by
 * webhook deduplication anyway.
 */

/**
 * How stale a PENDING row must be before it is re-driven.
 *
 * Long enough that a row the controller is enqueueing *right now* is never picked up
 * — the enqueue is bounded at 2s, so two minutes is a wide margin. Short enough that a
 * customer's wait is measured in minutes rather than hours.
 */
const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * Batch ceiling.
 *
 * The failure this guards is a long outage ending: thousands of PENDING rows becoming
 * eligible at once and being flushed into Redis, the model provider and Twilio in a
 * single burst. A bounded batch turns that into a paced drain — 100 a minute — which
 * also keeps model spend and Twilio's per-number throttle inside their normal bounds.
 */
const BATCH_SIZE = 100;

/**
 * How long a QUEUED row may sit before we check whether its job still exists.
 *
 * Redis losing job data — an unplanned flush, a restart without persistence, a
 * provider failover — leaves a row claiming to be queued with nothing to run it.
 * Generous, because a legitimately slow job (retries with exponential backoff) must
 * not be mistaken for a lost one.
 */
const ORPHAN_AFTER_MS = 15 * 60 * 1000;

/**
 * Past this, a missed call's recovery text is no longer worth sending.
 *
 * A product limit, not a technical one. "Sorry we missed your call" a day later reaches
 * someone who booked a competitor that afternoon, and an unexplained text from an
 * unknown number long after the fact reads as spam — which is precisely the territory
 * rule 10 keeps these messages out of.
 */
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Backlog age that stops being a blip and starts being an incident.
 *
 * Below this the reconciler is doing its job quietly. Above it, replies have been
 * undelivered for ten minutes and somebody needs to look at Redis.
 */
const ALERT_AFTER_MS = 10 * 60 * 1000;

/**
 * Greppable, stable prefix for log-based alerting.
 *
 * Deliberately a constant string with no interpolation in it, so an alert rule can
 * match on it exactly and will not silently stop matching when the message wording
 * around it changes.
 */
export const BACKLOG_ALERT = 'INBOUND_BACKLOG_ALERT';

@Injectable()
export class InboundReconcilerProcessor {
  private readonly logger = new Logger(InboundReconcilerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppressions: SuppressionsService,
    @Inject(queueToken(QUEUE.INBOUND_MESSAGE))
    private readonly inboundQueue: Queue<InboundMessageJobData>,
    @Inject(queueToken(QUEUE.RECOVERY))
    private readonly recoveryQueue: Queue<RecoveryJobData>,
  ) {}

  async process(): Promise<void> {
    await this.releaseOrphanedQueued();
    await this.redriveStuckPending();
    await this.redriveStuckRecoveries();
  }

  /**
   * Re-drive the *first* text after a missed call.
   *
   * The same failure as the inbound path, in the more damaging direction: if the
   * enqueue in `VoiceController` fails, the caller was told a text is coming and never
   * receives one. `calls.recoverySmsQueuedAt` is set at decision time, before the
   * enqueue, so it is already the outbox marker — a call carrying it with no recovery
   * message and no `noRecoveryReason` is work that was dropped.
   *
   * Scoped to a 24-hour window at both ends. The lower bound avoids racing an enqueue
   * in flight; the upper bound is a product judgement rather than a performance one —
   * a recovery text a day late is worse than none, so those are expired instead. It
   * also keeps the sweep a bounded range scan rather than one that grows with every
   * call ever recorded.
   */
  private async redriveStuckRecoveries(): Promise<void> {
    const now = Date.now();
    const notBefore = new Date(now - MAX_RECOVERY_AGE_MS);
    const notAfter = new Date(now - STALE_AFTER_MS);

    const stuck = await this.prisma.unscoped.call.findMany({
      where: {
        recoverySmsQueuedAt: { gte: notBefore, lt: notAfter },
        noRecoveryReason: null,
        // Excluded in SQL rather than filtered afterwards: without it every
        // successfully-recovered call stays eligible forever and the sweep re-enqueues
        // the entire history every minute.
        messages: { none: { direction: 'OUTBOUND', purpose: 'RECOVERY' } },
      },
      orderBy: { recoverySmsQueuedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, businessId: true, providerCallSid: true },
    });

    if (stuck.length > 0) {
      this.logger.error(
        `${BACKLOG_ALERT} ${stuck.length} missed call(s) were promised a text that was ` +
          'never queued. Re-driving.',
      );
    }

    for (const call of stuck) {
      const jobId = `recovery-${call.providerCallSid}`;
      try {
        const existing = await this.recoveryQueue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state === 'completed' || state === 'failed') {
            await existing.remove();
          } else {
            continue;
          }
        }
        await addJobBounded(
          this.recoveryQueue,
          'recovery',
          { callId: call.id, businessId: call.businessId },
          { jobId },
        );
      } catch (error) {
        this.logger.error(
          `Recovery reconciliation halted: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    // Anything past the window is closed out rather than left to be rescanned every
    // minute for the life of the table.
    const { count } = await this.prisma.unscoped.call.updateMany({
      where: {
        recoverySmsQueuedAt: { lt: notBefore },
        noRecoveryReason: null,
        messages: { none: { direction: 'OUTBOUND', purpose: 'RECOVERY' } },
      },
      data: { noRecoveryReason: 'EXPIRED' },
    });
    if (count > 0) {
      this.logger.error(
        `${BACKLOG_ALERT} ${count} missed call(s) never received their recovery text and ` +
          'are now too old to send — marked EXPIRED. These callers were lost.',
      );
    }
  }

  /**
   * Return QUEUED rows whose job no longer exists to PENDING.
   *
   * The hole this closes: a row is marked QUEUED, then Redis loses the job — a flush,
   * a restart without persistence, a failover. Nothing re-drives QUEUED, so that
   * customer waits forever while the row looks perfectly healthy.
   *
   * Only rows whose job is genuinely absent are touched. A job still waiting, active
   * or delayed is going to run, and reverting it would double-enqueue.
   */
  private async releaseOrphanedQueued(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_AFTER_MS);

    const queued = await this.prisma.unscoped.message.findMany({
      where: { direction: 'INBOUND', processingStatus: 'QUEUED', createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, businessId: true, providerMessageSid: true },
    });

    let released = 0;
    for (const message of queued) {
      const jobId = `inbound-${message.providerMessageSid ?? message.id}`;
      let job;
      try {
        job = await this.inboundQueue.getJob(jobId);
      } catch {
        // Redis unreachable — nothing to reconcile until it is back.
        return;
      }
      if (job) continue;

      // Conditional on still being QUEUED: the worker may have completed it between
      // the read above and this write.
      const { count } = await this.prisma.db.message.updateMany({
        where: { id: message.id, businessId: message.businessId, processingStatus: 'QUEUED' },
        data: { processingStatus: 'PENDING', processingNote: 'job lost from Redis — re-driving' },
      });
      released += count;
    }

    if (released > 0) {
      this.logger.error(
        `${BACKLOG_ALERT} ${released} inbound repl${released === 1 ? 'y was' : 'ies were'} ` +
          'marked QUEUED but had no job in Redis — job data was lost. Returned to PENDING.',
      );
    }
  }

  private async redriveStuckPending(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);

    // `unscoped` is correct and necessary here (docs/decisions.md D8). This sweep is
    // not performed on behalf of any one business — it asks "is any reply stuck?"
    // across the whole system, so there is no `businessId` to scope by. Tenant
    // isolation is preserved downstream: every write below is scoped by the
    // `businessId` read from the row, and the job carries that same id.
    //
    // The query is the reason `@@index([processingStatus, createdAt])` exists: an
    // equality match on the status seeks straight into the (normally empty) PENDING
    // range rather than scanning a table that grows with every message ever sent.
    const stuck = await this.prisma.unscoped.message.findMany({
      where: {
        direction: 'INBOUND',
        processingStatus: 'PENDING',
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        businessId: true,
        body: true,
        fromE164: true,
        providerMessageSid: true,
        createdAt: true,
      },
    });

    const oldest = stuck[0];
    if (!oldest) return;

    const oldestAgeMs = Date.now() - oldest.createdAt.getTime();
    const summary =
      `${stuck.length} inbound repl${stuck.length === 1 ? 'y' : 'ies'} stuck PENDING ` +
      `(oldest ${Math.round(oldestAgeMs / 1000)}s)`;

    // Two escalation triggers, because they mean different things. An old backlog
    // means replies have been undelivered for ten minutes. A *full* batch means we are
    // draining a queue deeper than one pass can clear, so the real backlog is unknown
    // and larger than this number.
    if (oldestAgeMs >= ALERT_AFTER_MS || stuck.length >= BATCH_SIZE) {
      this.logger.error(
        `${BACKLOG_ALERT} ${summary}. Customers have replied and received nothing. ` +
          'Check Redis availability and the inbound-message queue.',
      );
    } else {
      this.logger.warn(
        `${summary} — re-driving. A non-zero count here means an enqueue failed.`,
      );
    }

    let requeued = 0;
    let skipped = 0;

    for (const message of stuck) {
      // Defensive: the controller already stores a STOP as SKIPPED, so one should
      // never appear here. If it does, something wrote PENDING for an opt-out and
      // re-driving it would text someone who asked us not to.
      if (this.suppressions.classifyKeyword(message.body) === 'stop') {
        await this.settle(message.id, message.businessId, 'SKIPPED', 'STOP — no reply owed');
        skipped += 1;
        continue;
      }

      // Checked here as well as in the processor: during a long outage a customer may
      // have opted out through another channel, and the cheapest reply is the one
      // never queued.
      const suppressed = await this.suppressions.isSuppressed(message.businessId, message.fromE164);
      if (suppressed) {
        await this.settle(message.id, message.businessId, 'SKIPPED', `suppressed: ${suppressed}`);
        skipped += 1;
        continue;
      }

      const jobId = `inbound-${message.providerMessageSid ?? message.id}`;

      try {
        // **A completed job id cannot simply be re-added.** BullMQ treats the add as a
        // no-op and returns the existing job — measured: the handler does not run
        // again. Without this, any message whose job already ran but was left PENDING
        // (the `SENDING_ENABLED` pause is exactly that shape) would be marked QUEUED
        // by the line below and then never processed by anything. Silent, permanent.
        //
        // So: a terminal job is removed and re-added; a job still in flight is left
        // alone, because re-adding it is what would actually double up.
        const existing = await this.inboundQueue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();
          if (state === 'completed' || state === 'failed') {
            await existing.remove();
          } else {
            // waiting / active / delayed — it is going to run. Record that and move on.
            await this.settle(message.id, message.businessId, 'QUEUED', `job already ${state}`);
            requeued += 1;
            continue;
          }
        }

        // The same deterministic id the controller uses, so a concurrent enqueue from
        // either side collapses to one job rather than producing two replies.
        await addJobBounded(
          this.inboundQueue,
          'inbound',
          { messageId: message.id, businessId: message.businessId },
          { jobId },
        );
      } catch (error) {
        // Redis is still down. Abandon the rest of the batch rather than retrying 99
        // more times into the same wall — the remaining rows stay PENDING and the
        // next tick picks them up.
        this.logger.error(
          `Reconciliation halted after ${requeued} of ${stuck.length}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      // Only after BullMQ confirmed the add. Marking QUEUED first would reintroduce
      // exactly the bug this processor exists to fix, one layer down.
      await this.settle(message.id, message.businessId, 'QUEUED', 'requeued by reconciler');
      requeued += 1;
    }

    this.logger.log(`Reconciliation complete: ${requeued} requeued, ${skipped} skipped`);
  }

  /**
   * Advance a row, but only while it is still PENDING.
   *
   * Compare-and-set for the same reason as in the controller: the worker is a separate
   * process and can pick the job up, finish it, and write PROCESSED before this line
   * runs. An unconditional write would clobber PROCESSED back to QUEUED and leave a
   * fully-handled reply looking permanently stuck.
   */
  private async settle(
    messageId: string,
    businessId: string,
    status: 'QUEUED' | 'SKIPPED',
    note: string,
  ): Promise<void> {
    await this.prisma.db.message.updateMany({
      where: { id: messageId, businessId, processingStatus: 'PENDING' },
      data: {
        processingStatus: status,
        processedAt: status === 'SKIPPED' ? new Date() : null,
        processingNote: note,
      },
    });
  }
}
