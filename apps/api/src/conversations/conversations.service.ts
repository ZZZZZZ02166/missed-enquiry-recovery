import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConversationState } from '../generated/prisma/client';
import { recoveryHandoffMessage } from '../notifications/templates';
import { LLM_PROVIDER, type LlmProvider, type LlmTurn, type LlmUsage } from './llm.provider';
import { mergeAnswers } from './extraction';
import {
  isComplete,
  MAX_QUESTIONS,
  missingRequired,
  nextQuestion,
  pairedField,
  type CollectedAnswers,
  type FieldKey,
} from './question-flow';

/**
 * The conversation state machine.
 *
 * Takes the state of a thread plus one new customer reply, and returns what should
 * happen next. It does **not** touch the database and it does **not** send anything:
 * it loads nothing, writes nothing, and enqueues nothing.
 *
 * That separation is the point. The processor owns retries, idempotency and
 * persistence; this owns the decision. Mixing them produces logic that can only be
 * tested by standing up Postgres, Redis and a queue — which in practice means it
 * stops being tested at the edges, and the edges are where conversations break: the
 * fifth question, the reply that answers nothing, the customer who says "actually
 * make that 3 bedrooms" after we already asked something else.
 *
 * The one dependency is the model provider, because extraction is what turns a reply
 * into fields. With `FakeLlmProvider` that dependency is a scripted object, so every
 * path through this file is exercised without a network, a key, or a database.
 */

/** The persisted conversation fields this decision depends on. */
export interface ConversationSnapshot {
  state: ConversationState;
  collected: CollectedAnswers;
  awaitingField: string | null;
  questionsAsked: number;
  needsHuman: boolean;
  needsHumanReason: string | null;
}

export interface AdvanceInput {
  /** As stored on `businesses`. Truncated and made sendable by the templates. */
  businessName: string;
  conversation: ConversationSnapshot;
  /** The reply that triggered this, already persisted by the caller. */
  inboundText: string;
  /**
   * Prior turns, oldest first, excluding `inboundText`. Supplied by the caller
   * because loading them is a database concern.
   */
  priorTurns?: readonly LlmTurn[];
  /** The business's active service names, once the catalogue exists. */
  services?: readonly string[];
}

/**
 * Why we are replying. The processor uses this for logging and metrics; the customer
 * only ever sees `body`.
 */
export type ReplyKind = 'question' | 'handoff';

export interface ConversationDecision {
  /** The state to persist. */
  state: ConversationState;
  collected: CollectedAnswers;
  awaitingField: FieldKey | null;
  questionsAsked: number;
  needsHuman: boolean;
  needsHumanReason: string | null;

  /** What to send. Never null in practice — silence after a reply is never correct. */
  reply: { kind: ReplyKind; body: string };

  /**
   * True on the customer's first reply.
   *
   * The signal for lazy lead creation: **a call is not a lead** (`docs/decisions.md`).
   * Calls that never get a response stay as calls, which is what keeps the owner's
   * inbox honest and the headline metric truthful.
   */
  createLead: boolean;

  /** Required fields still outstanding — shown to the owner as gaps on the lead. */
  stillMissing: FieldKey[];

  /** Cost and latency attribution for this turn. */
  usage: LlmUsage;
  model: string;
  latencyMs: number;
  /** The model tried to quote. Never reaches the customer; surfaced for alerting. */
  attemptedToPrice: boolean;
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  /**
   * Advance a conversation by one customer reply.
   *
   * Extraction failures are deliberately **not** caught. An `LlmUnavailableError` is
   * transient by construction, and the queue retrying the whole turn is the correct
   * response — swallowing it here would mean answering a customer with a question we
   * already asked, or worse, treating "the model was overloaded" as "they told us
   * nothing", which permanently loses whatever they just said.
   */
  async advance(input: AdvanceInput): Promise<ConversationDecision> {
    const { conversation } = input;

    const turns: LlmTurn[] = [
      ...(input.priorTurns ?? []),
      { role: 'customer', text: input.inboundText },
    ];

    const result = await this.llm.extractFields({
      turns,
      collected: conversation.collected,
      services: input.services,
    });

    if (result.attemptedToPrice) {
      // Already dropped by the schema and logged by the provider. Repeated here with
      // the conversation in scope, because "some model somewhere quoted a price" is
      // much less actionable than knowing which business and which thread.
      this.logger.error(
        `Model attempted to price during a live conversation (business="${input.businessName}"). ` +
          'The figure was discarded, but the prompt needs review.',
      );
    }

    const collected = mergeAnswers(conversation.collected, result.extraction.answers);

    // A flag, not a state (schema comment on `needs_human`): it can be set at any
    // point and never interrupts the transition it accompanies. Once true it stays
    // true — a customer who mentioned a complaint halfway through has still
    // mentioned it, whatever they say afterwards.
    let needsHuman = conversation.needsHuman || result.extraction.requiresHuman;
    let needsHumanReason =
      conversation.needsHumanReason ?? result.extraction.requiresHumanReason ?? null;

    const createLead = conversation.state === 'AWAITING_FIRST_REPLY';
    const meta = {
      usage: result.usage,
      model: result.model,
      latencyMs: result.latencyMs,
      attemptedToPrice: result.attemptedToPrice,
    };

    // Ordered guards, most decisive first — the same shape as
    // `CallsService.decideRecovery`, and for the same reason: a conversation that
    // matches two conditions must resolve them in a defined order rather than
    // whichever branch happens to be written first.

    // 1. A human is needed. Stop qualifying. Continuing to ask about carpeted rooms
    //    after someone has raised a complaint or asked to negotiate is the single
    //    most damaging thing this system could do, and no amount of extra fields is
    //    worth it.
    if (needsHuman) {
      return {
        ...meta,
        state: 'COMPLETE',
        collected,
        awaitingField: null,
        questionsAsked: conversation.questionsAsked,
        needsHuman: true,
        needsHumanReason,
        reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
        createLead,
        stillMissing: missingRequired(collected),
      };
    }

    // 2. Everything required is answered. Hand it over rather than chasing optional
    //    fields the owner can ask about on the phone.
    if (isComplete(collected)) {
      return {
        ...meta,
        state: 'COMPLETE',
        collected,
        awaitingField: null,
        questionsAsked: conversation.questionsAsked,
        needsHuman: false,
        needsHumanReason: null,
        reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
        createLead,
        stillMissing: [],
      };
    }

    // 3. Something is still missing and we are allowed to ask.
    const question = nextQuestion(collected, conversation.questionsAsked);
    if (question) {
      return {
        ...meta,
        state: 'COLLECTING',
        collected,
        awaitingField: question.key,
        questionsAsked: conversation.questionsAsked + 1,
        needsHuman: false,
        needsHumanReason: null,
        reply: { kind: 'question', body: question.prompt },
        createLead,
        stillMissing: missingRequired(collected),
      };
    }

    // 4. `nextQuestion` returned null with required fields outstanding, which can
    //    only mean the ceiling was reached. Hand the partial lead over and flag it.
    //
    //    Reaching `MAX_QUESTIONS` without completing means extraction is failing, or
    //    the customer is answering something other than what we asked. Either way the
    //    right response is a person, not a sixth text — the schema comment on
    //    `questions_asked` calls this the hard stop against an infinite loop, and this
    //    is where it is enforced.
    const outstanding = missingRequired(collected);
    needsHuman = true;
    needsHumanReason =
      needsHumanReason ??
      `Reached the ${MAX_QUESTIONS}-question limit with ${outstanding.join(', ')} unanswered`;

    this.logger.warn(
      `Conversation hit the question ceiling with ${outstanding.length} required field(s) ` +
        `missing (${outstanding.join(', ')}). Handing a partial lead to the owner.`,
    );

    return {
      ...meta,
      state: 'COMPLETE',
      collected,
      awaitingField: null,
      questionsAsked: conversation.questionsAsked,
      needsHuman,
      needsHumanReason,
      reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
      createLead,
      stillMissing: outstanding,
    };
  }

  /**
   * The field a reply is attributed to when extraction produced nothing for it.
   *
   * `awaitingField` is stored rather than derived precisely so an out-of-order reply
   * can still be matched to the question it answers. Exposed for the processor's
   * logging: knowing that we asked about bedrooms and got back something unrelated is
   * the difference between "extraction is failing" and "this customer is confused".
   *
   * The paired field matters here — the bedrooms prompt asks about bathrooms in the
   * same breath, so a reply to it can legitimately answer either.
   */
  attributableFields(awaitingField: string | null): FieldKey[] {
    if (!awaitingField) return [];
    const key = awaitingField as FieldKey;
    const paired = pairedField(key);
    return paired ? [key, paired] : [key];
  }
}
