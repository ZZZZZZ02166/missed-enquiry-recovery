import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KnowledgeEntry } from 'shared-types';
import type { ConversationState } from '../generated/prisma/client';
import { assertSendable, segmentCount } from '../common/gsm7';
import { quotedHandoffMessage, recoveryHandoffMessage } from '../notifications/templates';
import {
  buildServiceList,
  isStillSelectable,
  resolveSelection,
  selectionRepromptMessage,
  shouldReprompt,
  CATALOGUE_ALERT,
  MAX_LIST_SEGMENTS,
  MAX_SELECTION_REPROMPTS,
  OPTION_WITHDRAWN_MESSAGE,
  OTHER_DESCRIPTION_PROMPT,
  type CatalogueEntry,
  type PresentedOption,
} from '../services/service-options';
import { matchKnowledge } from '../services/knowledge-matcher';
import { calculatePrice, type PriceResult, type PricingConfig } from '../services/price-calculator';
import { quoteMessage } from '../services/quote-message';
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
 *
 * **Service selection short-circuits the model entirely.** When a numbered menu is
 * outstanding, the reply is resolved arithmetically against the stored snapshot and
 * `advance` returns before `extractFields` is ever reached. That is a deliberate
 * structural choice rather than a condition inside the normal flow: it means an
 * unusable reply to a menu cannot cost a model call, cannot be turned into an answer,
 * and cannot select a service by inference.
 */

/**
 * The numbered menu as it was sent, plus where we are in that exchange.
 *
 * Mirrors `conversations.pendingChoice`. `options` is a snapshot and must be treated as
 * one: it is the only thing that says what "2" meant, and re-deriving it from the live
 * catalogue would let an owner's reorder repoint a caller's choice at a different job.
 */
export interface PendingChoice {
  stage: 'LIST' | 'DESCRIPTION';
  options: PresentedOption[];
  otherPosition: number;
  /** How many unusable replies have already been answered with the menu. */
  reprompts: number;
}

/** The persisted conversation fields this decision depends on. */
export interface ConversationSnapshot {
  state: ConversationState;
  collected: CollectedAnswers;
  awaitingField: string | null;
  questionsAsked: number;
  needsHuman: boolean;
  needsHumanReason: string | null;
  /** Raw `pendingChoice` JSON. Parsed defensively — it round-trips through the database. */
  pendingChoice?: unknown;
  selectedServiceId?: string | null;
}

/**
 * A catalogue entry with everything pricing needs.
 *
 * The menu only reads `id`, `name`, `availability` and `sortOrder`; quoting needs the
 * whole pricing config. Required rather than optional on purpose — an optional pricing
 * block would mean a processor that forgot to select the columns produces conversations
 * that silently never quote, which is the failure this system is least able to notice.
 */
export type PricedCatalogueEntry = CatalogueEntry & Omit<PricingConfig, 'id' | 'name' | 'availability'>;

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
  /**
   * The business's live service catalogue.
   *
   * Used for two different things that must not be confused: building a menu, and
   * re-validating a choice that was made against an older version of it.
   */
  catalogue?: readonly PricedCatalogueEntry[];
  /**
   * From `businesses.pricesIncludeGst`. Decides nothing the caller sees directly — the
   * figure is GST-inclusive either way (ACL single-price rule) — only how to get there
   * from what the owner typed.
   */
  pricesIncludeGst?: boolean;
  /**
   * The owner's approved answers, from `businesses.knowledge`.
   *
   * Optional, and absent means "do not try": a business that has imported nothing behaves
   * exactly as it did before this existed.
   */
  knowledge?: readonly KnowledgeEntry[];
}

/**
 * Why we are replying. The processor uses this for logging and metrics; the customer
 * only ever sees `body`.
 */
export type ReplyKind = 'question' | 'handoff' | 'menu' | 'reprompt' | 'answer';

export interface ConversationDecision {
  /** The state to persist. */
  state: ConversationState;
  collected: CollectedAnswers;
  awaitingField: FieldKey | null;
  questionsAsked: number;
  needsHuman: boolean;
  needsHumanReason: string | null;

  /**
   * The menu snapshot to persist, or null to clear it.
   *
   * Always present in the decision, never "leave it alone" — an outstanding choice that
   * is not explicitly cleared is one the next reply would be resolved against, long
   * after the question stopped applying.
   */
  pendingChoice: PendingChoice | null;

  /**
   * The chosen service, or null.
   *
   * Null is a real answer, not an absence: a caller who described something the
   * catalogue does not sell has no service id, and nothing downstream may compute a
   * price without one.
   */
  selectedServiceId: string | null;

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

  /**
   * Urgency as read from *this* reply, if it said anything about timing.
   *
   * Passed through rather than merged into `collected`, because it is a signal and
   * not an answer — the conversation never asks about it and it must not look like a
   * satisfied question. Undefined means this reply was silent on urgency, which is
   * not the same as "not urgent": whoever stores it should leave a previously
   * detected value alone.
   */
  urgency?: 'low' | 'normal' | 'high';

  /** Cost and latency attribution for this turn. */
  usage: LlmUsage;
  model: string;
  latencyMs: number;
  /** The model tried to quote. Never reaches the customer; surfaced for alerting. */
  attemptedToPrice: boolean;

  /**
   * The price computed for this conversation, when one was stated.
   *
   * Carried so the lead records exactly what the customer was told, including the
   * config snapshot — when the owner raises prices next month, the lead must still show
   * the old figure. Null whenever nothing was quoted, which is most conversations.
   */
  quote: PriceResult | null;
}

/**
 * Words that open a question.
 *
 * Used only to tell an unprompted question from an answer to something we just asked, so
 * it needs to be right about "saturday" versus "do you work saturdays?" and nothing more
 * subtle than that.
 */
const QUESTION_OPENERS = new Set([
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might',
  'must', 'are', 'is', 'am', 'was', 'were', 'have', 'has', 'had',
  'what', 'whats', 'how', 'when', 'where', 'which', 'who', 'why', 'any', 'anyone',
]);

/** A question mark, or an opening word only a question uses. */
function looksLikeAQuestion(text: string): boolean {
  if (text.includes('?')) return true;
  const first = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)[0];
  return first !== undefined && QUESTION_OPENERS.has(first);
}

/**
 * Attribution for a turn decided without the model.
 *
 * Reported as real zeroes rather than omitted, so "this turn cost nothing" is visible in
 * the same place as every other turn's cost. A menu reply that shows no usage is the
 * evidence that the short-circuit is working.
 */
const NO_MODEL: Pick<ConversationDecision, 'usage' | 'model' | 'latencyMs' | 'attemptedToPrice'> = {
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  model: 'none',
  latencyMs: 0,
  attemptedToPrice: false,
};

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
    const pending = parsePendingChoice(conversation.pendingChoice);

    // **Before extraction, on purpose.** A numbered menu is outstanding, so this reply
    // is a selection or it is nothing — there is no free text to understand, and asking
    // a model to interpret "2" would be spending money to introduce a way to be wrong.
    if (pending?.stage === 'LIST') {
      return this.resolveMenuReply(input, pending);
    }

    // Also before extraction, and for a related reason: if this is a question the owner
    // has already answered, there is nothing to extract and the answer is already
    // written. Returns null — falling through to the model — on anything less than a
    // certain match, which is most messages.
    const answered = this.answerFromKnowledge(input, pending);
    if (answered) return answered;

    const turns: LlmTurn[] = [
      ...(input.priorTurns ?? []),
      { role: 'customer', text: input.inboundText },
    ];

    const result = await this.llm.extractFields({
      turns,
      collected: conversation.collected,
      services: input.catalogue?.map((s) => s.name),
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

    let collected = mergeAnswers(conversation.collected, result.extraction.answers);

    // The caller chose "Other" and this reply is their description. Their own words win
    // over the model's reading of them, because the model was not asked to name a
    // service here and must not be allowed to imply one: a description that does not
    // match the catalogue is a manual-quote lead, and that is the correct outcome rather
    // than a failure to be recovered from.
    if (pending?.stage === 'DESCRIPTION') {
      const described = input.inboundText.trim();
      if (described.length > 0) collected = { ...collected, serviceType: described };
    }

    return this.qualify(input, collected, result, pending);
  }

  /**
   * Answer a common question from the owner's own words, without calling a model.
   *
   * **Every gate here is about not answering.** The saving is real but modest; what makes
   * this worth having is latency and resilience — an instant reply, and one that still
   * works when the model provider is down. Neither is worth a single wrong answer, so
   * this returns null unless it is certain, and null is the ordinary outcome.
   *
   * The gates, in the order they can fail. **Each one names a message that would
   * otherwise be mistaken for a question**, which is the only way to read them:
   *
   * 1. **The business has answers.** Absent means behave exactly as before.
   * 2. **This is not the first reply.** The first reply creates the lead and starts the
   *    enquiry. Answering an FAQ instead would hand the owner a lead with nothing in it
   *    and no question outstanding to fix that, so the enquiry has to begin before it can
   *    be interrupted.
   * 3. **We did not just ask them to describe the job.** A `DESCRIPTION` prompt is
   *    outstanding, so this reply is that description — intercepting it would answer a
   *    question they did not ask and discard what they did say.
   * 4. **If a question of ours is outstanding, this must look like a question.** The
   *    precise form of the gate that makes the matcher's known weakness safe: a bare
   *    "saturday" scores as the weekends entry, and it is a date answer if we just asked
   *    which day suits. Refusing *everything* while a field is outstanding was the first
   *    version and it was far too blunt — a field is outstanding for nearly the whole
   *    conversation, so "do you bring your own supplies?" asked while we wait on a suburb
   *    would never have been answered. Requiring question form separates the two.
   * 5. **The match is certain.** `matchKnowledge` refuses on ambiguity, on compound
   *    questions, and on anything carrying content it cannot account for — which is what
   *    keeps a reply mixing a question with field data out of here.
   * 6. **The answer is sendable.** Validated at save, but `businesses.knowledge` is a
   *    JSON column that predates its own validation and can be written by hand. An answer
   *    that would throw in `assertSendable` falls through to the model rather than
   *    failing the turn — the customer gets a reply either way.
   *
   * **What is deliberately *not* a gate: whether required fields are outstanding.** That
   * was the first version and it made the whole feature dead code — caught only by wiring
   * it end to end. Fields are outstanding for almost the entire life of a conversation,
   * and the moment one is not, after completion, a follow-up message starts a *new*
   * conversation with nothing collected and the gate closed again. It was also the wrong
   * instrument: what it reached for is "this message is an answer, not a question", and
   * gates 2-4 say that directly while the matcher's coverage rule handles the mixed
   * message properly.
   *
   * Nothing about the conversation moves: not `collected`, not `questionsAsked`, not the
   * question flow. Answering a question is not progress through the enquiry, and treating
   * it as though it were would skip a question the owner needs answered.
   */
  private answerFromKnowledge(
    input: AdvanceInput,
    pending: PendingChoice | null,
  ): ConversationDecision | null {
    const { conversation } = input;
    const knowledge = input.knowledge ?? [];

    if (knowledge.length === 0) return null;
    if (conversation.state === 'AWAITING_FIRST_REPLY') return null;
    if (pending?.stage === 'DESCRIPTION') return null;
    if (conversation.awaitingField !== null && !looksLikeAQuestion(input.inboundText)) return null;

    const match = matchKnowledge(knowledge, input.inboundText);
    if (match.reason !== 'matched' || match.entryId === null) {
      // Logged rather than stored. An unanswered question is worth seeing — it is how the
      // owner learns which answer to add next — but a column for it is a schema change
      // with one reader, and `docs/remaining-plan.md` carries it as the follow-up.
      this.logger.debug(
        `No stored answer for an inbound message (reason=${match.reason}` +
          `${match.tiedWith.length > 0 ? `, tied=${match.tiedWith.join(',')}` : ''})`,
      );
      return null;
    }

    const entry = knowledge.find((k) => k.id === match.entryId);
    const answer = entry?.answer?.trim();
    if (!entry || !answer) return null;

    try {
      assertSendable(answer, `knowledge answer ${entry.id}`, MAX_LIST_SEGMENTS);
    } catch {
      this.logger.warn(
        `Stored answer ${entry.id} cannot be sent as SMS — falling back to the model. ` +
          'It was almost certainly written directly to the database rather than through ' +
          'the dashboard, which validates charset and length.',
      );
      return null;
    }

    this.logger.log(
      `Answered from stored knowledge (entry=${entry.id}, confidence=${match.confidence}) — no model call`,
    );

    return {
      ...NO_MODEL,
      state: conversation.state,
      collected: conversation.collected,
      // Preserved, so whatever we asked is still outstanding after the detour. Cast the
      // same way `attributableFields` does — the column is a plain string that round-trips
      // through the database, and a value that is not a `FieldKey` was already unusable
      // before this branch existed.
      awaitingField: conversation.awaitingField as FieldKey | null,
      questionsAsked: conversation.questionsAsked,
      needsHuman: conversation.needsHuman,
      needsHumanReason: conversation.needsHumanReason,
      // The *parsed* value, preserved rather than cleared: this reply did not resolve or
      // invalidate an outstanding choice, and clearing one would silently drop a menu the
      // caller is still expected to answer. `conversation.pendingChoice` is the raw JSON
      // column and is not the same type.
      pendingChoice: pending,
      selectedServiceId: conversation.selectedServiceId ?? null,
      // The owner's words, verbatim. Nothing rewrites, summarises or generates around
      // them — the same guarantee `quoteMessage` gives for figures.
      reply: { kind: 'answer', body: answer },
      // Always false, and the compiler proves it: gate 2 already returned for the only
      // state in which a lead is created. Written as a constant rather than as the usual
      // comparison so it cannot read as an oversight — a lead is never created by
      // answering a question, because a question is not an enquiry.
      createLead: false,
      // Null does not erase a quote already recorded: `quoteColumns` writes no columns
      // for a null quote. Same as every other non-quoting branch.
      quote: null,
      stillMissing: missingRequired(conversation.collected),
    };
  }

  /**
   * A reply to the numbered menu. No model, no matcher, no inference.
   *
   * Every branch here either resolves to a service id that was on the list we sent, or
   * changes nothing about the service at all. There is no path from an unusable reply to
   * a selected service, which is the property the whole menu exists to provide.
   */
  private resolveMenuReply(input: AdvanceInput, pending: PendingChoice): ConversationDecision {
    const { conversation } = input;
    const base = {
      ...NO_MODEL,
      collected: conversation.collected,
      questionsAsked: conversation.questionsAsked,
      createLead: conversation.state === 'AWAITING_FIRST_REPLY',
      quote: null,
      stillMissing: missingRequired(conversation.collected),
    };

    const outcome = resolveSelection(input.inboundText, pending.options, pending.otherPosition);

    if (outcome.kind === 'invalid') {
      // **The best case this feature has, and the first version excluded it.** A caller
      // who replies to the menu with "do you bring your own supplies?" has not failed to
      // pick a number — they have asked something the owner already answered. Answering
      // it and leaving the menu outstanding is strictly better than re-prompting: they
      // get their answer, and their next reply can still be the number.
      //
      // Only reachable once the selection is known to be invalid, so a valid "2" can
      // never be diverted here.
      const answered = this.answerFromKnowledge(input, pending);
      if (answered) return answered;

      const reprompts = pending.reprompts + 1;

      // Nothing about the conversation moves. Not `collected`, not `selectedServiceId`,
      // not `questionsAsked`, not the question flow — an unusable reply is not an answer
      // to anything, and treating it as one is how a caller ends up with a service they
      // never picked. Only the re-prompt counter changes, and it is what makes this
      // terminate.
      if (shouldReprompt(pending.reprompts)) {
        return {
          ...base,
          state: 'COLLECTING',
          awaitingField: 'serviceType',
          needsHuman: conversation.needsHuman,
          needsHumanReason: conversation.needsHumanReason,
          pendingChoice: { ...pending, reprompts },
          selectedServiceId: conversation.selectedServiceId ?? null,
          reply: { kind: 'reprompt', body: selectionRepromptMessage(pending.otherPosition) },
        };
      }

      // Asked twice, answered with something else twice. A third identical message is
      // annoying, billable, and no more likely to work — so the enquiry goes to the
      // owner intact, with no service and no price, which is exactly what it is.
      this.logger.log(
        `Service selection abandoned after ${MAX_SELECTION_REPROMPTS} re-prompts ` +
          `(reason=${outcome.reason}). Handing the enquiry to the owner.`,
      );
      return {
        ...base,
        state: 'COMPLETE',
        awaitingField: null,
        needsHuman: true,
        needsHumanReason:
          conversation.needsHumanReason ??
          `Could not get a service selection after ${MAX_SELECTION_REPROMPTS} attempts`,
        pendingChoice: null,
        selectedServiceId: null,
        reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
      };
    }

    if (outcome.kind === 'other') {
      // A second message in the same exchange, and it increments `questionsAsked`
      // deliberately. The stage only ever moves LIST -> DESCRIPTION so this branch is
      // already bounded, but the question ceiling is the backstop that does not depend
      // on this file's own bookkeeping being right.
      return {
        ...base,
        state: 'COLLECTING',
        awaitingField: 'serviceType',
        questionsAsked: conversation.questionsAsked + 1,
        needsHuman: conversation.needsHuman,
        needsHumanReason: conversation.needsHumanReason,
        pendingChoice: { ...pending, stage: 'DESCRIPTION', reprompts: 0 },
        selectedServiceId: null,
        reply: { kind: 'question', body: OTHER_DESCRIPTION_PROMPT },
      };
    }

    // The snapshot said what the number meant. The live catalogue decides whether that
    // is still something the business sells — an owner who disabled a service while the
    // caller was typing must not have it quoted back at them.
    if (!isStillSelectable(outcome.serviceId, input.catalogue ?? [])) {
      return this.offerFreshMenu(input, base);
    }

    // Selected. The label the customer *read* becomes the answer, not the service's
    // current name — if the owner renames it tomorrow, the lead should still say what
    // was on screen.
    const collected = { ...conversation.collected, serviceType: outcome.name };
    return this.qualify(input, collected, null, null, { selectedServiceId: outcome.serviceId });
  }

  /**
   * The chosen option was withdrawn between sending the list and reading the reply.
   *
   * Tell them plainly and re-ask with the current catalogue. Never substitute a
   * neighbouring service, and never fall through to a price.
   */
  private offerFreshMenu(
    input: AdvanceInput,
    base: Omit<ConversationDecision, 'state' | 'awaitingField' | 'needsHuman' | 'needsHumanReason' | 'pendingChoice' | 'selectedServiceId' | 'reply'>,
  ): ConversationDecision {
    const { conversation } = input;
    const rebuilt = buildServiceList(input.catalogue ?? []);
    const body = rebuilt.ok ? `${OPTION_WITHDRAWN_MESSAGE}\n\n${rebuilt.prompt.body}` : '';

    // Two messages joined into one send. Checked rather than assumed: the apology plus a
    // six-option menu is the longest thing this file can produce, and quietly shipping a
    // third segment to every affected caller is not how we would want to find that out.
    if (rebuilt.ok && segmentCount(body) <= MAX_LIST_SEGMENTS) {
      this.logger.log(
        'The service the customer chose was withdrawn before their reply arrived; ' +
          're-asking with the current catalogue.',
      );
      return {
        ...base,
        state: 'COLLECTING',
        awaitingField: 'serviceType',
        needsHuman: conversation.needsHuman,
        needsHumanReason: conversation.needsHumanReason,
        pendingChoice: {
          stage: 'LIST',
          options: rebuilt.prompt.options,
          otherPosition: rebuilt.prompt.otherPosition,
          // Reset: they answered the previous list correctly, and the list changed
          // underneath them. Carrying their strikes forward would punish them for the
          // owner's edit.
          reprompts: 0,
        },
        selectedServiceId: null,
        reply: { kind: 'menu', body },
      };
    }

    // No menu can be offered any more — the catalogue emptied, or is misconfigured.
    // Hand over rather than improvise.
    this.logger.warn(
      'A selected service was withdrawn and no replacement menu could be built ' +
        `(${rebuilt.ok ? 'combined message too long' : rebuilt.reason}). Handing to the owner.`,
    );
    return {
      ...base,
      state: 'COMPLETE',
      awaitingField: null,
      needsHuman: true,
      needsHumanReason:
        conversation.needsHumanReason ?? 'The service the customer chose is no longer available',
      pendingChoice: null,
      selectedServiceId: null,
      reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
    };
  }

  /**
   * The qualification decision, shared by the model path and the menu path.
   *
   * `result` is null when this turn was decided without the model — the ordered guards
   * below are identical either way, which is the point: a conversation that arrives here
   * from a menu selection must be treated exactly like one that arrived from a sentence.
   */
  private qualify(
    input: AdvanceInput,
    collected: CollectedAnswers,
    result: Awaited<ReturnType<LlmProvider['extractFields']>> | null,
    pending: PendingChoice | null,
    overrides: { selectedServiceId?: string } = {},
  ): ConversationDecision {
    const { conversation } = input;

    // A flag, not a state (schema comment on `needs_human`): it can be set at any
    // point and never interrupts the transition it accompanies. Once true it stays
    // true — a customer who mentioned a complaint halfway through has still
    // mentioned it, whatever they say afterwards.
    const needsHuman = conversation.needsHuman || (result?.extraction.requiresHuman ?? false);
    const needsHumanReason =
      conversation.needsHumanReason ?? result?.extraction.requiresHumanReason ?? null;

    const createLead = conversation.state === 'AWAITING_FIRST_REPLY';
    const selectedServiceId = overrides.selectedServiceId ?? conversation.selectedServiceId ?? null;
    const meta = result
      ? {
          usage: result.usage,
          model: result.model,
          latencyMs: result.latencyMs,
          attemptedToPrice: result.attemptedToPrice,
          urgency: result.extraction.urgency,
        }
      : NO_MODEL;

    // The menu exchange is over the moment we get here: either a service was chosen or
    // a description was given. Cleared explicitly, because an outstanding choice left
    // behind would capture the *next* reply as an answer to a question nobody asked.
    const clearedPending = null;

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
        pendingChoice: clearedPending,
        selectedServiceId,
        reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
        createLead,
        quote: null,
        stillMissing: missingRequired(collected),
      };
    }

    // 2. Everything required is answered. Hand it over rather than chasing optional
    //    fields the owner can ask about on the phone — and this is where a price, if
    //    there is one, reaches the caller.
    if (isComplete(collected)) {
      const quoted = this.priceFor(input, selectedServiceId, collected);
      return {
        ...meta,
        state: 'COMPLETE',
        collected,
        awaitingField: null,
        questionsAsked: conversation.questionsAsked,
        needsHuman: false,
        needsHumanReason: null,
        pendingChoice: clearedPending,
        selectedServiceId,
        reply: {
          kind: 'handoff',
          body: quoted.body
            ? `${quoted.body} ${quotedHandoffMessage(input.businessName)}`
            : recoveryHandoffMessage(input.businessName),
        },
        createLead,
        quote: quoted.price,
        stillMissing: [],
      };
    }

    // 3. Something is still missing and we are allowed to ask.
    //
    //    `questionsAsked` already counts the prompt that produced the description, so a
    //    caller who went through "Other" is not charged twice for one exchange.
    const askedForDescription = pending?.stage === 'DESCRIPTION';
    const question = nextQuestion(collected, conversation.questionsAsked);
    if (question) {
      // The service question is the one that becomes a menu, when the business has a
      // catalogue that can carry one.
      if (question.key === 'serviceType') {
        const menu = this.serviceMenu(input);
        if (menu.kind === 'menu') {
          return {
            ...meta,
            state: 'COLLECTING',
            collected,
            awaitingField: 'serviceType',
            questionsAsked: conversation.questionsAsked + 1,
            needsHuman: false,
            needsHumanReason: null,
            pendingChoice: menu.pendingChoice,
            selectedServiceId,
            reply: { kind: 'menu', body: menu.body },
            createLead,
            quote: null,
            stillMissing: missingRequired(collected),
          };
        }
        if (menu.kind === 'misconfigured') {
          // Not a fallback to the open question. `assertCatalogueValid` blocks this at
          // save, so reaching it means a write bypassed validation and the catalogue in
          // the database is not one the owner agreed to. Serving a quietly degraded
          // conversation would hide that for as long as it took someone to notice by
          // hand; handing to a person surfaces it on the first affected caller.
          this.logger.error(
            `${CATALOGUE_ALERT} business="${input.businessName}" ${menu.reason}: ${menu.detail}`,
          );
          return {
            ...meta,
            state: 'COMPLETE',
            collected,
            awaitingField: null,
            questionsAsked: conversation.questionsAsked,
            needsHuman: true,
            needsHumanReason: `Service catalogue is invalid (${menu.reason})`,
            pendingChoice: clearedPending,
            selectedServiceId,
            reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
            createLead,
            quote: null,
            stillMissing: missingRequired(collected),
          };
        }
        // menu.kind === 'none' — a business with fewer than two active services has
        // nothing to list, and the open question serves them correctly. This is every
        // business that has not finished onboarding, so it is the common case, not an
        // error.
      }

      return {
        ...meta,
        state: 'COLLECTING',
        collected,
        awaitingField: question.key,
        questionsAsked: conversation.questionsAsked + 1,
        needsHuman: false,
        needsHumanReason: null,
        pendingChoice: clearedPending,
        selectedServiceId,
        reply: { kind: 'question', body: question.prompt },
        createLead,
        quote: null,
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
    const ceilingReason =
      needsHumanReason ??
      `Reached the ${MAX_QUESTIONS}-question limit with ${outstanding.join(', ')} unanswered`;

    this.logger.warn(
      `Conversation hit the question ceiling with ${outstanding.length} required field(s) ` +
        `missing (${outstanding.join(', ')})${askedForDescription ? ' after an Other description' : ''}. ` +
        'Handing a partial lead to the owner.',
    );

    return {
      ...meta,
      state: 'COMPLETE',
      collected,
      awaitingField: null,
      questionsAsked: conversation.questionsAsked,
      needsHuman: true,
      needsHumanReason: ceilingReason,
      pendingChoice: clearedPending,
      selectedServiceId,
      reply: { kind: 'handoff', body: recoveryHandoffMessage(input.businessName) },
      createLead,
      quote: null,
      stillMissing: outstanding,
    };
  }

  /**
   * The price for the selected service, and the words for it.
   *
   * **Quoted once, at completion, and never before.** Not because earlier would be
   * unwelcome — a number in ninety seconds is the whole pitch — but because quoting at
   * every turn needs a durable "already quoted" marker, and writing one before the send
   * is exactly the shape rule 13 exists to forbid. Completion is terminal, so once is
   * guaranteed by the state machine rather than by bookkeeping. Quoting earlier is a
   * follow-up, and it needs `leads.quotedAt` consulted *before* the message is composed.
   *
   * Returns no words in every case where a figure would be indefensible: no service
   * chosen, the service gone from the catalogue, a manual-quote service, an answer still
   * missing, or an owner who does not want prices stated on their behalf. `price` is
   * still returned in some of those cases, because the owner's lead may legitimately
   * carry a figure the customer was never told (`showPriceAutomatically`).
   */
  private priceFor(
    input: AdvanceInput,
    selectedServiceId: string | null,
    collected: CollectedAnswers,
  ): { price: PriceResult | null; body: string | null } {
    if (!selectedServiceId) return { price: null, body: null };

    // Re-read from the live catalogue rather than trusting anything stored: a service
    // disabled since the customer chose it must not be priced, which is the same rule
    // `isStillSelectable` applies to the choice itself.
    const service = input.catalogue?.find(
      (s) => s.id === selectedServiceId && s.availability === 'ACTIVE',
    );
    if (!service) return { price: null, body: null };

    const price = calculatePrice(service, collected, {
      pricesIncludeGst: input.pricesIncludeGst ?? false,
    });

    // `quoteMessage` is the only thing that renders a figure, and it takes a
    // `PriceResult` rather than a number — so there is no path from here to a currency
    // amount this system did not compute (rule 2).
    return { price, body: quoteMessage(service.name, price) };
  }

  /** Build the menu for this business, classifying the three outcomes that matter here. */
  private serviceMenu(
    input: AdvanceInput,
  ):
    | { kind: 'menu'; body: string; pendingChoice: PendingChoice }
    | { kind: 'none' }
    | { kind: 'misconfigured'; reason: string; detail: string } {
    const result = buildServiceList(input.catalogue ?? []);
    if (result.ok) {
      return {
        kind: 'menu',
        body: result.prompt.body,
        pendingChoice: {
          stage: 'LIST',
          options: result.prompt.options,
          otherPosition: result.prompt.otherPosition,
          reprompts: 0,
        },
      };
    }
    if (result.kind === 'MISCONFIGURED') {
      return { kind: 'misconfigured', reason: result.reason, detail: result.detail };
    }
    return { kind: 'none' };
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

/**
 * Read `conversations.pendingChoice` back into something safe to act on.
 *
 * Everything here is untrusted: it is JSON that round-tripped through the database and
 * may have been written by an older version of this code. A malformed snapshot returns
 * null, which means the reply is treated as ordinary free text — the conversation
 * continues and nothing is mis-selected, which is the right way to fail. Throwing would
 * kill a job for a customer whose only mistake was replying.
 *
 * Note the deliberate strictness on `options`: one bad entry invalidates the whole
 * snapshot rather than being skipped, because dropping an option silently renumbers
 * nothing — the positions are stored, not derived — but it would let "3" resolve to a
 * list the customer never saw.
 */
export function parsePendingChoice(value: unknown): PendingChoice | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  if (raw.stage !== 'LIST' && raw.stage !== 'DESCRIPTION') return null;
  if (!Array.isArray(raw.options)) return null;
  if (typeof raw.otherPosition !== 'number' || !Number.isInteger(raw.otherPosition)) return null;

  const options: PresentedOption[] = [];
  for (const entry of raw.options) {
    if (entry === null || typeof entry !== 'object') return null;
    const option = entry as Record<string, unknown>;
    if (typeof option.position !== 'number' || !Number.isInteger(option.position)) return null;
    if (typeof option.serviceId !== 'string' || option.serviceId.length === 0) return null;
    if (typeof option.name !== 'string') return null;
    options.push({ position: option.position, serviceId: option.serviceId, name: option.name });
  }

  const reprompts = typeof raw.reprompts === 'number' && Number.isInteger(raw.reprompts) ? raw.reprompts : 0;
  return { stage: raw.stage, options, otherPosition: raw.otherPosition, reprompts };
}
