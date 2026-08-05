import { MAX_ACTIVE_SERVICES, MAX_SERVICE_NAME_CHARS } from 'shared-types';
import type { ServiceAvailability } from '../generated/prisma/client';
import { assertSendable, isGsm7, normaliseToGsm7, segmentCount } from '../common/gsm7';

/**
 * The numbered service list a caller picks from, and its **strictly numeric** reply
 * resolver.
 *
 * Exists so that choosing a service involves no guessing at all. `service-matcher.ts`
 * is careful and well tested and still fuzzy; a caller replying "2" is not. Where the
 * business has a catalogue, the caller picks, and nothing infers.
 *
 * **Two safety properties hold the whole file up.**
 *
 * 1. *A list position means nothing on its own.* The mapping from `2` to a service id
 *    is decided when the list is **sent** and persisted with the conversation.
 *    Re-deriving it at reply time would mean an owner reordering their catalogue while
 *    the caller types silently repoints the choice at a different job, and therefore a
 *    different price. `isStillSelectable` is the second half: the snapshot decides what
 *    the number *meant*, the live catalogue decides whether it can *still* be chosen.
 *
 * 2. *A reply is a selection or it is nothing.* The entire trimmed message must be one
 *    integer in range. No prose, no written numbers, no digits pulled out of a
 *    sentence. Everything else is `invalid` and gets a re-prompt — it is never fed to
 *    extraction or to the matcher, and it never becomes an answer.
 *
 * Pure and dependency-free, like `price-calculator.ts` and `service-matcher.ts`, so
 * every branch is provable without a database.
 */

/** The subset of a `Service` row the list needs. */
export interface CatalogueEntry {
  id: string;
  name: string;
  availability: ServiceAvailability;
  sortOrder: number;
}

/** One line of the sent list. Persisted verbatim — this *is* the durable mapping. */
export interface PresentedOption {
  position: number;
  serviceId: string;
  /**
   * The label as sent, already GSM-7 safe and truncated. Kept so a re-prompt and the
   * owner's lead can quote what the caller actually saw, even if the service has since
   * been renamed.
   */
  name: string;
}

export interface ServiceListPrompt {
  /** The message body. Asserted against the segment budget before it is returned. */
  body: string;
  options: PresentedOption[];
  /** The position of "Other". Always last, never a service id. */
  otherPosition: number;
}

/**
 * Below this, a list is worse than a question.
 *
 * A one-item menu ("1. End of lease clean / 2. Other") reads as a machine failing to
 * ask a question. With zero or one active service there is nothing to disambiguate, so
 * an open prompt is friendlier and no less safe.
 */
export const MIN_SERVICES_TO_LIST = 2;

/**
 * Segment budget for the list message.
 *
 * Two, not one. Four options with a header and a blank line come to 156 characters —
 * inside a single segment today, but a business with longer names must not silently
 * start costing three. The alternatives were worse: truncating names into ambiguity, or
 * splitting the menu across messages and inventing pagination state. Asserted in
 * `buildServiceList` rather than assumed (CLAUDE.md rule 5).
 */
export const MAX_LIST_SEGMENTS = 2;

/**
 * Per-label cap, and the same number the owner's form enforces.
 *
 * Re-exported from the shared rules rather than declared here, so a name that validates
 * in the dashboard is a name that appears in the menu in full. The truncation below
 * survives only as defence for rows written before the rule existed.
 */
export const MAX_OPTION_NAME_CHARS = MAX_SERVICE_NAME_CHARS;

/**
 * How many times an unusable reply is answered with the menu before we stop.
 *
 * Small on purpose. Someone who has sent two replies that are not a number is not going
 * to send a number on the third, and repeating the same message at them is both
 * annoying and billable. At the limit the enquiry is preserved for the owner to ring
 * back — no service id, no price, nothing guessed.
 */
export const MAX_SELECTION_REPROMPTS = 2;

const HEADER = 'What service do you need? Reply with one number only.';
const OTHER_LABEL = 'Other';

/** Sent when the caller picks "Other". Their free text becomes `collected.serviceType`. */
export const OTHER_DESCRIPTION_PROMPT = 'Please briefly describe the service you need.';

/**
 * Sent when a chosen option was disabled or deleted between the list and the reply.
 *
 * Deliberately says nothing about which service or why. The caller does not need the
 * owner's catalogue admin narrated at them, and "no longer available" is the whole
 * truth from their side.
 */
export const OPTION_WITHDRAWN_MESSAGE = 'Sorry, that option is no longer available.';

/**
 * Greppable, stable prefix for log-based alerting.
 *
 * Same convention as `BACKLOG_ALERT` in the reconciler: a constant string with no
 * interpolation inside it, so an alert rule matches exactly and does not silently stop
 * matching when the wording around it changes.
 */
export const CATALOGUE_ALERT = 'INVALID_CATALOGUE';

/** Fewer than two usable active services. Not an error — there is simply nothing to list. */
export type NoMenuReason = 'NO_CATALOGUE';

/**
 * The catalogue itself is invalid.
 *
 * **These should be unreachable.** `assertCatalogueValid` blocks both at save, so a
 * business cannot have seven active services or names longer than the validated maximum.
 * Seeing one here means a write bypassed validation — a seed script, a bulk import, a
 * direct SQL change, or a bug — and the catalogue in the database is not one any owner
 * agreed to.
 */
export type MisconfiguredReason = 'TOO_MANY_ACTIVE' | 'DOES_NOT_FIT';

/**
 * Why a menu could not be built.
 *
 * The union is split on `kind` rather than flattened into one list of reasons, and that
 * is the whole point: it makes it impossible to write a handler that treats a corrupt
 * catalogue the same way as an empty one. An empty catalogue is a business that has not
 * finished setting up, and the open question serves them correctly. A catalogue with
 * seven active services is data that should not exist, and quietly asking an open
 * question would hide it for as long as it took someone to notice manually.
 */
export type ServiceListResult =
  | { ok: true; prompt: ServiceListPrompt }
  | { ok: false; kind: 'NO_MENU'; reason: NoMenuReason; detail: string }
  | { ok: false; kind: 'MISCONFIGURED'; reason: MisconfiguredReason; detail: string };

/**
 * Build the numbered list for a business's live catalogue.
 *
 * **Never trims a valid catalogue to fit, and never papers over an invalid one.** An
 * earlier version sliced silently at six, which meant an owner's seventh service was
 * configured, active, visible in their dashboard, and unreachable by every caller — with
 * nothing anywhere saying so.
 *
 * Returns a result rather than throwing. This runs inside a job processor answering a
 * real customer, and a throw would fail the job, retry forever, and leave that person in
 * silence. The result says what is wrong; deciding what the caller hears is the
 * processor's job, and for `MISCONFIGURED` that decision is a handoff to the owner plus
 * an alert — never the open-question flow, which would let broken data keep serving
 * customers indefinitely.
 */
export function buildServiceList(catalogue: readonly CatalogueEntry[]): ServiceListResult {
  const active = catalogue.filter((s) => s.availability === 'ACTIVE');

  // Checked before anything is cleaned or ordered, so the report names the real problem
  // rather than whichever symptom surfaced first.
  if (active.length > MAX_ACTIVE_SERVICES) {
    return {
      ok: false,
      kind: 'MISCONFIGURED',
      reason: 'TOO_MANY_ACTIVE',
      detail:
        `${active.length} active services, limit is ${MAX_ACTIVE_SERVICES}. ` +
        'This cannot be saved through the dashboard, so the rows were written by something ' +
        'that bypassed validation.',
    };
  }

  // Order, clean, *then* count.
  //
  // Names are owner-entered, so they are the most likely source of a curly apostrophe
  // or an emoji — either of which drops the segment limit from 160 to 70 and can triple
  // the bill for every caller (rule 5). Made safe here, once, rather than trusted
  // anywhere downstream. A name that cleans down to nothing is dropped, because a bare
  // "3." is not something a caller can choose.
  const usable = active
    // The owner's own ordering, with a stable tiebreak so two services sharing a
    // sortOrder cannot swap places between one send and the next. That matters more
    // than it looks: the snapshot makes a swap harmless for an in-flight reply, but an
    // unstable order makes the *list itself* different every time it is sent.
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((service) => ({ serviceId: service.id, name: toLabel(service.name) }))
    .filter((o) => o.name.length > 0);

  if (usable.length < MIN_SERVICES_TO_LIST) {
    return {
      ok: false,
      kind: 'NO_MENU',
      reason: 'NO_CATALOGUE',
      detail: `${usable.length} usable active service(s); a menu needs ${MIN_SERVICES_TO_LIST}.`,
    };
  }

  const options: PresentedOption[] = usable.map((o, index) => ({ position: index + 1, ...o }));
  const body = render(options);

  // With the active-service ceiling enforced at save, the worst case is six labels at the
  // validated maximum length — 279 characters against a 306-character budget — so this
  // cannot fire on data that went through the dashboard. If it does, a name is longer
  // than validation allows, which is the same class of problem as the check above.
  if (segmentCount(body) > MAX_LIST_SEGMENTS) {
    return {
      ok: false,
      kind: 'MISCONFIGURED',
      reason: 'DOES_NOT_FIT',
      detail:
        `${options.length} options render to ${segmentCount(body)} segments, budget is ` +
        `${MAX_LIST_SEGMENTS}. Service names exceed the validated maximum of ` +
        `${MAX_OPTION_NAME_CHARS} characters.`,
    };
  }

  return { ok: true, prompt: { body, options, otherPosition: options.length + 1 } };
}

function render(options: readonly PresentedOption[]): string {
  const lines = options.map((o) => `${o.position}. ${o.name}`);
  // The blank line separates the instruction from the choices. One character, and it is
  // the difference between a menu and a wall of text on a phone.
  return [HEADER, '', ...lines, `${options.length + 1}. ${OTHER_LABEL}`].join('\n');
}

/**
 * An owner-entered service name, made safe to put in an SMS.
 *
 * `normaliseToGsm7` maps the lookalikes — curly quotes, en dashes, ellipsis — which is
 * the right behaviour for message text a developer wrote. It does not, and should not,
 * remove characters with no GSM-7 equivalent. Service names are not developer text: an
 * owner who types "Sarah's premium clean ✨" into the dashboard would otherwise turn
 * every caller's list into a UCS-2 message, where the segment limit drops from 160
 * characters to 70. So anything still outside the charset after mapping is dropped.
 */
function toLabel(name: string): string {
  const mapped = normaliseToGsm7(name);
  const stripped = [...mapped].filter((char) => isGsm7(char)).join('');
  const clean = stripped.trim().replace(/\s+/g, ' ');
  if (clean.length <= MAX_OPTION_NAME_CHARS) return clean;
  // Trailing dots and spaces are stripped before the ellipsis dot is added, so a name
  // cut mid-abbreviation reads as "Deep clean." rather than "Deep clean..".
  return `${clean.slice(0, MAX_OPTION_NAME_CHARS - 1).replace(/[.\s]+$/, '')}.`;
}

/** What a reply to the list turned out to be. */
export type SelectionOutcome =
  | { kind: 'selected'; serviceId: string; name: string }
  | { kind: 'other' }
  /**
   * Anything that is not exactly one in-range integer.
   *
   * One outcome, not several, because every one of them is handled identically: send
   * the same re-prompt and keep waiting. `reason` exists only for the note left on the
   * lead when we give up, never for a branch in the conversation.
   */
  | { kind: 'invalid'; reason: 'not_a_number' | 'out_of_range' };

/**
 * Resolve a reply against the options that were actually sent.
 *
 * `options` must come from the stored snapshot, never from a fresh catalogue read. That
 * is the entire point of the snapshot, and passing a live list here would compile
 * cleanly while reintroducing exactly the bug it prevents.
 *
 * **The entire trimmed message must be one integer.** Not "a message containing a
 * number" — `2 bedrooms`, `option 2` and `1,3` are all rejected, and so are the written
 * forms `one`/`two`/`three`. The looser version of this function needed a table of unit
 * words to stop "2 bedrooms" selecting option 2, and a comma-splitting rule to catch
 * "1,3"; both of those heuristics disappear here, because a rule with no exceptions
 * needs no exceptions handled. A caller who types anything else gets asked again, which
 * costs one message and cannot pick the wrong job.
 */
export function resolveSelection(
  reply: string,
  options: readonly PresentedOption[],
  otherPosition: number,
): SelectionOutcome {
  // Leading and trailing whitespace only — a stray newline from a phone keyboard is
  // not the caller failing to follow instructions.
  const trimmed = (reply ?? '').trim();

  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid', reason: 'not_a_number' };

  // A 30-digit reply parses to something imprecise rather than throwing, and a longer
  // one to Infinity. Neither needs its own branch: both fail the membership checks
  // below and land on `out_of_range`, which is the correct answer anyway.
  const position = Number.parseInt(trimmed, 10);

  if (position === otherPosition) return { kind: 'other' };

  const chosen = options.find((o) => o.position === position);
  // Covers 0, 7 against a five-option list, and any number never shown. There is no
  // "closest option" fallback on purpose: guessing which service a caller meant from a
  // number they did not see is the wrong-price failure in its purest form.
  if (!chosen) return { kind: 'invalid', reason: 'out_of_range' };

  return { kind: 'selected', serviceId: chosen.serviceId, name: chosen.name };
}

/**
 * The message sent after an unusable reply.
 *
 * The range comes from the snapshot's `otherPosition`, never a constant — a business
 * with three services must not be told to reply "1 to 5". Asserted to one segment at
 * the widest range this file can produce.
 */
export function selectionRepromptMessage(otherPosition: number): string {
  return `Sorry, please reply with one number only, from 1 to ${otherPosition}.`;
}

/**
 * Whether an unusable reply should be answered with the menu again.
 *
 * `reprompts` is the count *already* sent. False means stop asking and hand the enquiry
 * to the owner — with no service id and no price, because nothing was ever established.
 */
export function shouldReprompt(reprompts: number): boolean {
  return reprompts < MAX_SELECTION_REPROMPTS;
}

/**
 * Whether a snapshot option is still safe to act on.
 *
 * The other half of the snapshot contract. An owner who disabled a service while the
 * caller was typing must not have it quoted back at them — so a stale choice degrades
 * to a fresh list, never to a price and never to a neighbouring service.
 */
export function isStillSelectable(
  serviceId: string,
  catalogue: readonly CatalogueEntry[],
): boolean {
  return catalogue.some((s) => s.id === serviceId && s.availability === 'ACTIVE');
}

/**
 * Assert the fixed messages at module load.
 *
 * Same reasoning as `question-flow.ts` and `notifications/templates.ts`: a message that
 * silently costs three times as much must not be deployable, and an import cannot be
 * skipped the way a test can. The re-prompt is checked at the widest range this file
 * can generate, since that is its longest possible form.
 */
assertSendable(OTHER_DESCRIPTION_PROMPT, 'other-description prompt');
assertSendable(OPTION_WITHDRAWN_MESSAGE, 'withdrawn-option message');
assertSendable(
  selectionRepromptMessage(MAX_ACTIVE_SERVICES + 1),
  'service selection re-prompt',
);
