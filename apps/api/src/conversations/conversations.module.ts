import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { llmProviderFactory } from './llm-provider.factory';
import { LLM_PROVIDER } from './llm.provider';

/**
 * The conversation engine.
 *
 * No controllers, for the same reason `CallsModule` has none: customer replies
 * arrive through Twilio webhooks, which belong to `TelephonyModule`. This module
 * owns what happens *after* a reply is authenticated and recorded — extraction, the
 * question flow, and deciding what to send next.
 *
 * Right now it registers exactly one thing: the model provider. That single
 * registration is what turns three files of correct-but-unreachable code into
 * something the application can inject, and it is the point at which a
 * misconfiguration becomes a boot failure rather than a runtime surprise — the
 * factory's production check runs at module construction, not at first use.
 *
 * `LLM_PROVIDER` is exported because the consumer is a **job processor**, not
 * anything in this module. Extraction happens on the worker: it is slow, it is
 * billed per call, and it must never run inside a Twilio webhook, which times out
 * around 15 seconds (CLAUDE.md rule 8). `JobsModule` will import this module the
 * same way it already imports `CallsModule` and `TelephonyModule`.
 *
 * `ConversationsService` is exported for the same reason: it is the decision, and
 * the processor is what persists and sends. It is deliberately not folded into that
 * processor — the processor should own retries and idempotency, not conversation
 * logic, and the logic needs to be testable without a queue.
 */
@Module({
  providers: [llmProviderFactory, ConversationsService],
  exports: [LLM_PROVIDER, ConversationsService],
})
export class ConversationsModule {}
