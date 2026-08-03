import { Inject, Injectable, Logger } from '@nestjs/common';
import { SuppressionsService } from '../../calls/suppressions.service';
import { env } from '../../config/env';
import { ConversationsService } from '../../conversations/conversations.service';
import type { LlmTurn } from '../../conversations/llm.provider';
import type { CollectedAnswers } from '../../conversations/question-flow';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PermanentSendError,
  SMS_PROVIDER,
  type SmsProvider,
} from '../../telephony/sms.provider';
import type { InboundMessageJobData } from '../queues';

/**
 * Turns a customer's reply into the next message.
 *
 * Loads the thread, asks `ConversationsService` what to do, persists the answer, and
 * sends. It is the plumbing around a decision it does not make — the same division as
 * `RecoveryProcessor`, and the reason the state machine could be verified without a
 * database.
 *
 * Runs on the worker, never in a webhook. Extraction is a paid model call taking
 * seconds; Twilio times out around 15 (rule 8). The webhook's only job is to persist
 * the inbound message and enqueue this.
 */

/** How much of the thread the model sees. Matches the provider's own cap. */
const THREAD_WINDOW = 12;

@Injectable()
export class InboundMessageProcessor {
  private readonly logger = new Logger(InboundMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly suppressions: SuppressionsService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {}

  async process(data: InboundMessageJobData): Promise<void> {
    const { messageId, businessId } = data;

    const message = await this.prisma.db.message.findFirst({
      where: { businessId, id: messageId },
      include: { business: { select: { name: true } } },
    });

    if (!message) {
      this.logger.warn(`Inbound job for unknown message ${messageId} — dropping`);
      return;
    }
    if (message.direction !== 'INBOUND') {
      // A bug in whatever enqueued this. Loud, and terminal — it will never become
      // inbound, so re-driving it every minute would be pure noise.
      this.logger.error(`Message ${messageId} is ${message.direction}, not INBOUND — dropping`);
      await this.finish(messageId, businessId, 'FAILED', 'not an inbound message');
      return;
    }
    if (!message.customerId) {
      this.logger.warn(`Inbound message ${messageId} has no customer — dropping`);
      await this.finish(messageId, businessId, 'FAILED', 'no customer attributed');
      return;
    }

    const conversation = await this.findOrCreateConversation(businessId, message.customerId);

    // Terminal and never reopened, whatever they send afterwards.
    if (conversation.state === 'OPTED_OUT') {
      this.logger.log(`Conversation ${conversation.id} is opted out — not replying`);
      await this.finish(messageId, businessId, 'SKIPPED', 'conversation opted out');
      return;
    }

    // Idempotency by state, not by job id. `lastInboundAt` advances only once a
    // reply has been fully processed, so a retried job sees its own message already
    // accounted for and stops.
    //
    // It also handles the case a jobId could not: two replies arriving in quick
    // succession. Whichever job runs second sees a `lastInboundAt` older than its
    // own message and proceeds — with the first reply already in the thread it
    // sends to the model. Out-of-order execution collapses to one reply covering
    // both, which is what a person would do.
    if (conversation.lastInboundAt && conversation.lastInboundAt >= message.createdAt) {
      this.logger.debug(`Message ${messageId} already processed — skipping`);
      // PROCESSED, not SKIPPED: the work genuinely happened, either on a previous
      // attempt of this job or in a later reply that superseded it. This is also the
      // path that repairs a crash between the conversation write and the status
      // write — without it the row would sit QUEUED forever.
      await this.finish(messageId, businessId, 'PROCESSED', 'superseded by a later reply');
      return;
    }

    // Re-checked here rather than trusted from the webhook: the job may have waited
    // while the customer sent STOP, and the state that matters is the state now.
    if (!env.SENDING_ENABLED) {
      this.logger.warn(`Sending disabled — leaving message ${messageId} PENDING for later`);
      // Back to PENDING, not SKIPPED. The kill switch is temporary by design, and
      // these customers are owed a reply once it is flipped back — the reconciler
      // re-drives them automatically. Bounded batches keep the retry cheap while the
      // switch is off.
      await this.finish(messageId, businessId, 'PENDING', 'sending disabled at process time');
      return;
    }
    const suppressed = await this.suppressions.isSuppressed(businessId, message.fromE164);
    if (suppressed) {
      this.logger.log(`Not replying to ${message.fromE164}: ${suppressed}`);
      await this.finish(messageId, businessId, 'SKIPPED', `suppressed: ${suppressed}`);
      return;
    }

    const decision = await this.conversations.advance({
      businessName: message.business.name,
      conversation: {
        state: conversation.state,
        collected: (conversation.collected ?? {}) as CollectedAnswers,
        awaitingField: conversation.awaitingField,
        questionsAsked: conversation.questionsAsked,
        needsHuman: conversation.needsHuman,
        needsHumanReason: conversation.needsHumanReason,
      },
      inboundText: message.body,
      priorTurns: await this.priorTurns(businessId, message.customerId, message.createdAt),
    });

    if (decision.awaitingField && conversation.awaitingField) {
      const expected = this.conversations.attributableFields(conversation.awaitingField);
      const answered = expected.some((f) => decision.collected[f] !== undefined);
      if (!answered) {
        // Not an error — people reply out of order. Worth logging because a run of
        // these is the signal that extraction is failing rather than that customers
        // are confused.
        this.logger.log(
          `Reply to "${conversation.awaitingField}" did not answer it ` +
            `(conversation ${conversation.id})`,
        );
      }
    }

    // Persisted before sending, deliberately — the opposite of the recovery path,
    // and for the opposite reason. There, a row written first could suppress a real
    // send. Here, a send that succeeds while the state write is lost would ask the
    // same question again on the next reply, which the customer experiences as the
    // system not listening. Re-sending is the cheaper failure.
    await this.prisma.db.conversation.update({
      where: { id: conversation.id, businessId },
      data: {
        state: decision.state,
        collected: decision.collected as object,
        awaitingField: decision.awaitingField,
        questionsAsked: decision.questionsAsked,
        needsHuman: decision.needsHuman,
        needsHumanReason: decision.needsHumanReason,
        lastInboundAt: message.createdAt,
        completedAt: decision.state === 'COMPLETE' ? new Date() : null,
      },
    });

    if (decision.createLead) {
      // A call is not a lead; a reply is (docs/decisions.md). The `leads` table does
      // not exist yet, so this is the seam and not the implementation — logged so
      // the gap is visible rather than silently skipped.
      this.logger.log(
        `First reply on conversation ${conversation.id} — lead creation pending the leads table`,
      );
    }

    await this.reply(message, businessId, decision.reply.kind, decision.reply.body);

    // Last, and only on the success path. A transient model or SMS failure throws
    // before reaching here, leaving the row QUEUED for BullMQ's retry — which is
    // correct, because the work is genuinely still outstanding.
    await this.finish(messageId, businessId, 'PROCESSED', null);

    this.logger.log(
      `Conversation ${conversation.id} → ${decision.state} ` +
        `(${decision.usage.inputTokens}+${decision.usage.outputTokens} tokens, ${decision.latencyMs}ms` +
        `${decision.stillMissing.length ? `, missing ${decision.stillMissing.join('/')}` : ''})`,
    );
  }

  /**
   * Record the terminal processing state of an inbound message.
   *
   * Every exit path from `process()` goes through here, so no row is left in QUEUED
   * with nothing to explain it. `PENDING` is a legitimate argument: it hands the
   * message back to the reconciler for a genuinely temporary condition.
   *
   * Deliberately not wrapped in a transaction with the conversation write. If this
   * update is the thing that fails, the retry hits the `lastInboundAt` check above and
   * lands on PROCESSED — self-healing, and cheaper than a transaction spanning an
   * external send.
   */
  private async finish(
    messageId: string,
    businessId: string,
    status: 'PENDING' | 'PROCESSED' | 'SKIPPED' | 'FAILED',
    note: string | null,
  ): Promise<void> {
    await this.prisma.db.message.update({
      where: { id: messageId, businessId },
      data: {
        processingStatus: status,
        // Only a terminal state gets a timestamp; PENDING is going back in the queue.
        processedAt: status === 'PENDING' ? null : new Date(),
        processingNote: note,
      },
    });
  }

  /**
   * The open conversation for this customer, creating or reopening as needed.
   *
   * `EXPIRED` reopens: someone who texts back two days later is still a lead, and
   * starting a fresh thread would re-ask everything they already answered. Only
   * `OPTED_OUT` is truly terminal.
   */
  private async findOrCreateConversation(businessId: string, customerId: string) {
    const existing = await this.prisma.db.conversation.findFirst({
      where: {
        businessId,
        customerId,
        state: { in: ['AWAITING_FIRST_REPLY', 'COLLECTING', 'OPTED_OUT', 'EXPIRED'] },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (existing?.state === 'EXPIRED') {
      this.logger.log(`Reopening expired conversation ${existing.id}`);
      return this.prisma.db.conversation.update({
        where: { id: existing.id, businessId },
        data: { state: 'COLLECTING' },
      });
    }
    if (existing) return existing;

    // No prior conversation — a reply to a number that never called, or one whose
    // conversation was already completed. Either way they are talking to us now.
    this.logger.log(`Starting a conversation for customer ${customerId} from an inbound reply`);
    return this.prisma.db.conversation.create({
      data: { businessId, customerId, state: 'AWAITING_FIRST_REPLY', lastInboundAt: null },
    });
  }

  /**
   * The thread so far, oldest first, excluding the message being processed.
   *
   * Reconstructed from `messages` rather than stored on the conversation: `messages`
   * is already the record of what was actually said, and a second copy would be a
   * second thing to keep in sync.
   */
  private async priorTurns(
    businessId: string,
    customerId: string,
    before: Date,
  ): Promise<LlmTurn[]> {
    const rows = await this.prisma.db.message.findMany({
      where: { businessId, customerId, createdAt: { lt: before } },
      orderBy: { createdAt: 'desc' },
      take: THREAD_WINDOW,
      select: { direction: true, body: true },
    });

    return rows.reverse().map(
      (m): LlmTurn => ({
        role: m.direction === 'INBOUND' ? 'customer' : 'business',
        text: m.body,
      }),
    );
  }

  /**
   * Send the reply and record it.
   *
   * The message row is written *after* the provider call, as in the recovery path:
   * a row claiming a message that was never queued is worse than a missing record of
   * one that was.
   */
  private async reply(
    inbound: { customerId: string | null; fromE164: string; toE164: string },
    businessId: string,
    kind: 'question' | 'handoff',
    body: string,
  ): Promise<void> {
    // The number they texted is the number we reply from — swapping `to` and `from`
    // rather than looking the business's number up again, so a mid-conversation
    // number change cannot move the thread to a different sender.
    const from = inbound.toE164;
    const to = inbound.fromE164;
    const purpose = kind === 'question' ? 'QUALIFICATION' : 'HANDOFF';

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
          customerId: inbound.customerId,
          direction: 'OUTBOUND',
          status: 'QUEUED',
          purpose,
          fromE164: from,
          toE164: to,
          body,
          providerMessageSid: result.providerMessageSid,
          segments: result.segments,
          sentAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof PermanentSendError) {
        this.logger.warn(`Permanent failure replying to ${to}: ${error.message}`);
        await this.prisma.db.message.create({
          data: {
            businessId,
            customerId: inbound.customerId,
            direction: 'OUTBOUND',
            status: 'FAILED',
            purpose,
            fromE164: from,
            toE164: to,
            body,
            errorCode: error.code,
            errorMessage: error.message,
          },
        });
        if (error.code === 21610) await this.suppressions.optOut(businessId, to);
        // Swallowed: retrying is guaranteed to fail identically.
        return;
      }
      throw error;
    }
  }
}
