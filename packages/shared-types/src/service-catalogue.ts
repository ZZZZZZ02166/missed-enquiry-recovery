/**
 * The rules a business's service catalogue must satisfy, and the defaults a new
 * business starts with.
 *
 * **Why this lives in a shared package rather than in the API.** The dashboard has to
 * reject a bad service name while the owner is typing, and the API has to reject it
 * again on save — a browser is not a trust boundary. Two implementations of "what is a
 * valid name" drift within weeks, and the failure is silent: the form accepts something
 * the server rejects, or worse, the server accepts something the form would have caught.
 * One module, imported by both, is the only version of this that stays true.
 *
 * Runtime-agnostic on purpose (`types: []` in tsconfig). No `process`, no `Buffer`, no
 * Prisma import — anything here must run identically in Node and in a browser.
 */

/**
 * Mirrors Prisma's `ServiceAvailability`.
 *
 * Duplicated rather than imported because this package must not depend on the generated
 * client. Drift is caught for free at the call sites: the API passes `service.availability`
 * (the Prisma enum) into these functions, so if Prisma gains a member this union lacks,
 * that assignment stops compiling.
 */
export type ServiceAvailability = 'ACTIVE' | 'DISABLED' | 'TEMPORARILY_UNAVAILABLE';

/**
 * How many services may be `ACTIVE` at once.
 *
 * This is a **product limit, not a display limit.** The customer-facing menu is one SMS,
 * a caller will not read past six numbered options, and truncating the list at send time
 * would mean the owner's seventh service silently never reaches anybody. So the ceiling
 * is enforced where the owner can see and fix it — at save — and the menu builder treats
 * a catalogue that exceeds it as a configuration error rather than something to quietly
 * trim. Services beyond the limit stay `DISABLED`; nothing is lost, it just is not
 * offered.
 */
export const MAX_ACTIVE_SERVICES = 6;

/**
 * Name length bounds.
 *
 * The maximum matches the menu's per-label cap exactly, so a name that validates is a
 * name that appears in full. The truncation in the menu builder survives only as defence
 * for rows written before this rule existed.
 */
export const MIN_SERVICE_NAME_CHARS = 2;
export const MAX_SERVICE_NAME_CHARS = 32;

/**
 * The characters a service name may contain.
 *
 * An allowlist, and deliberately narrower than GSM-7. Two reasons:
 *
 *  - The name is echoed into a customer-facing SMS, so anything outside GSM-7 would drop
 *    the segment limit from 160 characters to 70 and can triple the bill (CLAUDE.md
 *    rule 5).
 *  - GSM-7 itself includes the currency symbols, and a service called "Deep clean $99"
 *    would put a price in front of a caller that never passed through `PriceCalculator`.
 *    Rule 2 says every currency figure comes from the calculator; the cheapest way to
 *    keep that true is to make it impossible to type one into a name.
 */
const ALLOWED_NAME_CHARACTERS = /^[A-Za-z0-9 '()\-./&,+]+$/;

/** Called out separately so the owner is told *why*, not just "invalid character". */
const CURRENCY_CHARACTERS = /[$£€¥¢₹]/;

/** At least one letter — a service named "2" is unreadable in a numbered menu. */
const HAS_LETTER = /[A-Za-z]/;

export type CatalogueIssueCode =
  | 'NAME_EMPTY'
  | 'NAME_TOO_SHORT'
  | 'NAME_TOO_LONG'
  | 'NAME_HAS_CURRENCY'
  | 'NAME_UNSUPPORTED_CHARACTERS'
  | 'NAME_NO_LETTERS'
  | 'NAME_DUPLICATE'
  | 'SORT_ORDER_NOT_AN_INTEGER'
  | 'SORT_ORDER_NEGATIVE'
  | 'SORT_ORDER_DUPLICATE'
  | 'TOO_MANY_ACTIVE'
  | 'PRICE_REQUIRED'
  | 'PRICE_NEGATIVE'
  | 'PRICE_ON_MANUAL_QUOTE'
  | 'UNIT_LABEL_REQUIRED'
  | 'UNIT_RANGE_INVALID';

export interface CatalogueIssue {
  code: CatalogueIssueCode;
  /**
   * Shown to the owner verbatim. Written as a sentence that says what to do, because an
   * error the owner cannot act on is the same as no error.
   */
  message: string;
  /** Which service, when it is about one. Absent for whole-catalogue rules. */
  serviceId?: string;
  /** Position in the submitted list, for a form whose rows do not have ids yet. */
  index?: number;
}

/** The four ways a service can be priced. Mirrors Prisma's `PricingType`. */
export type PricingType = 'FIXED' | 'STARTING_FROM' | 'PER_UNIT' | 'MANUAL_QUOTE';

/** The pricing fields, as the dashboard submits them. */
export interface ServicePricingDraft {
  pricingType: PricingType;
  priceCents?: number | null;
  unitLabel?: string | null;
  minUnits?: number | null;
  maxUnits?: number | null;
}

/** A service as the dashboard submits it — before it necessarily has an id. */
export interface CatalogueDraftEntry extends Partial<ServicePricingDraft> {
  id?: string;
  name: string;
  availability: ServiceAvailability;
  sortOrder: number;
}

/**
 * Validate the pricing configuration of one service.
 *
 * **Why this is a save-time rule and not left to the calculator.** `PriceCalculator`
 * already refuses to quote a half-configured service — it returns `NOT_CONFIGURED` and
 * the conversation falls through to a manual quote. That is the correct runtime
 * behaviour and it is completely invisible to the owner: they set a service to `FIXED`,
 * forget the price, and then simply never find out why no customer was ever quoted. The
 * failure is silent, permanent, and costs them the exact thing they bought the product
 * for.
 *
 * So the rule lives where they can see it. A `FIXED` service without a price cannot be
 * saved.
 */
export function validateServicePricing(entry: Partial<ServicePricingDraft>): CatalogueIssue[] {
  const issues: CatalogueIssue[] = [];
  const { pricingType, priceCents, unitLabel, minUnits, maxUnits } = entry;
  if (!pricingType) return issues;

  const needsPrice = pricingType === 'FIXED' || pricingType === 'STARTING_FROM' || pricingType === 'PER_UNIT';

  if (needsPrice && (priceCents === null || priceCents === undefined)) {
    issues.push({
      code: 'PRICE_REQUIRED',
      message:
        pricingType === 'PER_UNIT'
          ? 'Set the rate per unit, or change this to "quote manually".'
          : 'Set a price, or change this to "quote manually".',
    });
  }

  if (typeof priceCents === 'number' && priceCents < 0) {
    issues.push({ code: 'PRICE_NEGATIVE', message: 'A price cannot be negative.' });
  }

  // Zero is deliberately allowed — a free callout is a real offer an owner may make.

  if (pricingType === 'MANUAL_QUOTE' && typeof priceCents === 'number') {
    issues.push({
      code: 'PRICE_ON_MANUAL_QUOTE',
      message:
        'This service is set to quote manually, so the price is never used. Remove it, or ' +
        'choose a pricing type that shows it.',
    });
  }

  if (pricingType === 'PER_UNIT') {
    if (!unitLabel || unitLabel.trim().length === 0) {
      issues.push({
        code: 'UNIT_LABEL_REQUIRED',
        message: 'Say what is being counted — "room", "hour", "window".',
      });
    }
    const lo = minUnits ?? null;
    const hi = maxUnits ?? null;
    const badBound = (v: number | null) => v !== null && (!Number.isInteger(v) || v < 0);
    if (badBound(lo) || badBound(hi) || (lo !== null && hi !== null && lo > hi)) {
      issues.push({
        code: 'UNIT_RANGE_INVALID',
        // The bounds are what stop "12 bedrooms" from a two-bedroom flat being priced as
        // a real job rather than treated as a misread.
        message: 'The smallest and largest quantities must be whole numbers, with the smallest first.',
      });
    }
  }

  return issues;
}

/**
 * A name reduced to the text we actually judge.
 *
 * Tolerates a non-string because this runs against a browser form as well as a validated
 * request body: a validator that throws on bad input is worse than useless, since the one
 * job it has is to be the thing that does not fall over. Anything that is not a string
 * reads as an empty name, which is exactly what the owner needs to fix.
 *
 * Note the deliberate limit: `validateCatalogue` still expects an array and throws if
 * handed something else. Reporting "valid" for a non-array would be a far more dangerous
 * tolerance than a crash.
 */
function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * Validate one name, in isolation.
 *
 * Separated from `validateCatalogue` so a form can call it on every keystroke without
 * re-checking the whole list. Duplicate detection is *not* here — it needs the siblings.
 */
export function validateServiceName(name: string): CatalogueIssue[] {
  const issues: CatalogueIssue[] = [];
  const trimmed = cleanName(name);

  if (trimmed.length === 0) {
    return [{ code: 'NAME_EMPTY', message: 'Give this service a name.' }];
  }
  if (trimmed.length < MIN_SERVICE_NAME_CHARS) {
    issues.push({
      code: 'NAME_TOO_SHORT',
      message: `Use at least ${MIN_SERVICE_NAME_CHARS} characters so callers know what it is.`,
    });
  }
  if (trimmed.length > MAX_SERVICE_NAME_CHARS) {
    issues.push({
      code: 'NAME_TOO_LONG',
      message:
        `Keep it to ${MAX_SERVICE_NAME_CHARS} characters — it has to fit in a text message. ` +
        `That name is ${trimmed.length}.`,
    });
  }
  if (CURRENCY_CHARACTERS.test(trimmed)) {
    issues.push({
      code: 'NAME_HAS_CURRENCY',
      message:
        'Service names cannot contain prices. Set the price in the pricing fields so it is ' +
        'calculated and shown correctly, including GST.',
    });
  } else if (!ALLOWED_NAME_CHARACTERS.test(trimmed)) {
    issues.push({
      code: 'NAME_UNSUPPORTED_CHARACTERS',
      message:
        'Use letters, numbers, spaces and basic punctuation only. Emoji and special ' +
        'characters make every text message cost more to send.',
    });
  }
  if (!HAS_LETTER.test(trimmed)) {
    issues.push({
      code: 'NAME_NO_LETTERS',
      message: 'Include at least one word — a name made only of numbers is confusing in a list.',
    });
  }

  return issues;
}

/**
 * Validate the whole catalogue as the owner is about to save it.
 *
 * Returns every issue rather than the first, because a form that reveals one problem per
 * save is how a five-field mistake takes five round trips. The list is stable and ordered
 * by entry so the dashboard can attach each issue to its row.
 */
export function validateCatalogue(entries: readonly CatalogueDraftEntry[]): CatalogueIssue[] {
  const issues: CatalogueIssue[] = [];

  entries.forEach((entry, index) => {
    for (const issue of validateServiceName(entry.name)) {
      issues.push({ ...issue, serviceId: entry.id, index });
    }
    for (const issue of validateServicePricing(entry)) {
      issues.push({ ...issue, serviceId: entry.id, index });
    }

    if (!Number.isInteger(entry.sortOrder)) {
      issues.push({
        code: 'SORT_ORDER_NOT_AN_INTEGER',
        message: 'Position must be a whole number.',
        serviceId: entry.id,
        index,
      });
    } else if (entry.sortOrder < 0) {
      issues.push({
        code: 'SORT_ORDER_NEGATIVE',
        message: 'Position cannot be negative.',
        serviceId: entry.id,
        index,
      });
    }
  });

  // Case-insensitive, whitespace-collapsed. The database's unique index on
  // (businessId, name) is case-*sensitive*, so it would happily accept both "Deep clean"
  // and "deep clean" — two rows that are one service to any caller reading the menu.
  const seenNames = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = cleanName(entry.name).toLowerCase().replace(/\s+/g, ' ');
    if (key.length === 0) return;
    const first = seenNames.get(key);
    if (first === undefined) {
      seenNames.set(key, index);
      return;
    }
    issues.push({
      code: 'NAME_DUPLICATE',
      message: `You already have a service called "${cleanName(entries[first]!.name)}". Rename one of them.`,
      serviceId: entry.id,
      index,
    });
  });

  const active = entries.filter((e) => e.availability === 'ACTIVE');

  // Only among active services. Two disabled rows sharing a position cannot affect what
  // any caller sees, and rejecting it would be a rule the owner cannot understand.
  const seenOrders = new Map<number, number>();
  active.forEach((entry) => {
    const index = entries.indexOf(entry);
    if (!Number.isInteger(entry.sortOrder)) return;
    const first = seenOrders.get(entry.sortOrder);
    if (first === undefined) {
      seenOrders.set(entry.sortOrder, index);
      return;
    }
    issues.push({
      code: 'SORT_ORDER_DUPLICATE',
      // Ties make the menu order depend on a tiebreak the owner never chose, so the
      // list they see in the dashboard stops matching the one the caller receives.
      message: `Two active services share position ${entry.sortOrder}. Give each one its own place in the list.`,
      serviceId: entry.id,
      index,
    });
  });

  if (active.length > MAX_ACTIVE_SERVICES) {
    issues.push({
      code: 'TOO_MANY_ACTIVE',
      message:
        `You can have ${MAX_ACTIVE_SERVICES} active services at a time — the list has to fit in ` +
        `one text message. You have ${active.length}. Turn ${active.length - MAX_ACTIVE_SERVICES} ` +
        'of them off; they are kept and can be turned back on any time.',
    });
  }

  return issues;
}

/** Convenience for a caller that only needs the yes/no. */
export function isCatalogueValid(entries: readonly CatalogueDraftEntry[]): boolean {
  return validateCatalogue(entries).length === 0;
}

/**
 * Thrown when a save is attempted with a catalogue that breaks the rules.
 *
 * Carries every issue, so an API layer can turn it into a 422 the dashboard renders
 * against the offending rows rather than a generic "save failed".
 */
export class CatalogueValidationError extends Error {
  constructor(readonly issues: readonly CatalogueIssue[]) {
    super(`Service catalogue is invalid: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'CatalogueValidationError';
  }
}

/**
 * Block an invalid catalogue at the point of writing it.
 *
 * The throwing form exists so the save path cannot *forget* to check. `validateCatalogue`
 * returns issues, which a caller can ignore by accident; this one cannot be ignored, and
 * every write of `services` rows — the dashboard endpoint, onboarding, a seed script, a
 * future bulk import — must go through it.
 *
 * That matters more than it looks. Once writes are guarded here, a catalogue that
 * violates `MAX_ACTIVE_SERVICES` cannot exist, which is what turns the equivalent check
 * at *send* time from a fallback into an alarm: if the menu builder ever sees seven
 * active services, something bypassed this function, and the correct response is to wake
 * someone rather than quietly serve a degraded conversation.
 */
export function assertCatalogueValid(entries: readonly CatalogueDraftEntry[]): void {
  const issues = validateCatalogue(entries);
  if (issues.length > 0) throw new CatalogueValidationError(issues);
}

/** A service a new business starts with. */
export interface DefaultService {
  name: string;
  sortOrder: number;
  /**
   * Always `MANUAL_QUOTE`, and this is not a placeholder.
   *
   * A default *price* would be a number this system invented on a business's behalf and
   * then quoted to their customers — the exact thing CLAUDE.md rule 2 exists to prevent.
   * Defaults supply the vocabulary, the owner supplies every figure. Until they do, an
   * enquiry becomes a manual-quote lead, which is the correct answer for a business that
   * has not told us what it charges.
   */
  pricingType: 'MANUAL_QUOTE';
  showPriceAutomatically: false;
}

/**
 * The onboarding catalogue for an end-of-lease cleaning business.
 *
 * A starting point the owner edits, not a fixed set — every one can be renamed, disabled,
 * reordered or replaced. It exists because an empty catalogue means no menu, and a new
 * business should see the flow working on day one rather than after a configuration
 * session.
 */
export const DEFAULT_CLEANING_SERVICES: readonly DefaultService[] = [
  { name: 'End-of-lease cleaning', sortOrder: 0, pricingType: 'MANUAL_QUOTE', showPriceAutomatically: false },
  { name: 'Regular house cleaning', sortOrder: 1, pricingType: 'MANUAL_QUOTE', showPriceAutomatically: false },
  { name: 'Deep cleaning', sortOrder: 2, pricingType: 'MANUAL_QUOTE', showPriceAutomatically: false },
  { name: 'Carpet steam cleaning', sortOrder: 3, pricingType: 'MANUAL_QUOTE', showPriceAutomatically: false },
];

/**
 * Assert the defaults satisfy the rules, at module load.
 *
 * Same reasoning as the GSM-7 assertions in the API: shipping a default catalogue that
 * the validator would reject is a bug nobody finds until a real owner opens the form and
 * cannot save data they never entered. An import cannot be skipped the way a test can.
 */
const defaultIssues = validateCatalogue(
  DEFAULT_CLEANING_SERVICES.map((s) => ({ name: s.name, sortOrder: s.sortOrder, availability: 'ACTIVE' as const })),
);
if (defaultIssues.length > 0) {
  throw new Error(
    `DEFAULT_CLEANING_SERVICES violates the catalogue rules: ${defaultIssues
      .map((i) => `${i.code} (${i.message})`)
      .join('; ')}`,
  );
}

// ---------------------------------------------------------------------------
// Business knowledge — the facts the SMS flow answers from without a model call.
// ---------------------------------------------------------------------------

/**
 * One thing the business knows, and the words it says about it.
 *
 * `answer` is sent to a customer **verbatim**. Nothing rewrites it, summarises it or
 * generates around it — the model's only job is to decide which entry a question is
 * about, exactly as it decides which service a caller means rather than composing a
 * price. That keeps the property the whole architecture rests on: every word a customer
 * receives is either owner-authored or produced by deterministic code.
 */
export interface KnowledgeEntry {
  id: string;
  /** The canonical phrasing, shown to the owner. "Do you bring your own supplies?" */
  question: string;
  /** Other ways a caller might ask it. Matching is over these plus the question. */
  aliases: string[];
  /** The owner's words. Sent as-is. */
  answer: string;
  /** What the imported document said, kept so a wrong entry can be traced. */
  sourceExcerpt?: string;
}

export const MAX_KNOWLEDGE_ENTRIES = 40;
export const MAX_KNOWLEDGE_QUESTION_CHARS = 120;

/**
 * An answer must fit two SMS segments.
 *
 * The same budget the service menu gets. An answer is sent on its own, so this is its
 * whole allowance — and at 306 GSM-7 characters it is more than enough for "yes, we
 * bring everything including vacuum and products", while stopping an owner from pasting
 * three paragraphs of terms and conditions that costs five segments to every caller who
 * asks.
 */
export const MAX_KNOWLEDGE_ANSWER_CHARS = 300;

export type KnowledgeIssueCode =
  | 'QUESTION_EMPTY'
  | 'QUESTION_TOO_LONG'
  | 'ANSWER_EMPTY'
  | 'ANSWER_TOO_LONG'
  | 'ANSWER_HAS_CURRENCY'
  | 'UNSUPPORTED_CHARACTERS'
  | 'DUPLICATE_QUESTION'
  | 'TOO_MANY_ENTRIES';

export interface KnowledgeIssue {
  code: KnowledgeIssueCode;
  message: string;
  entryId?: string;
  index?: number;
}

/**
 * Validate one entry.
 *
 * **The currency rule is the important one.** An owner typing "minimum callout is $80"
 * into an answer would put a figure in front of a customer that never passed through
 * `PriceCalculator` — so it is not GST-adjusted, not snapshotted onto the lead, and not
 * covered by the guard that makes rule 2 fail CI. A minimum callout is a service with a
 * price, not a sentence. Refusing here is what stops the knowledge base becoming a hole
 * in the pricing rules.
 */
export function validateKnowledgeEntry(entry: Partial<KnowledgeEntry>): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  const question = cleanName(entry.question);
  const answer = cleanName(entry.answer);

  if (question.length === 0) {
    issues.push({ code: 'QUESTION_EMPTY', message: 'Write the question a caller would ask.' });
  } else if (question.length > MAX_KNOWLEDGE_QUESTION_CHARS) {
    issues.push({
      code: 'QUESTION_TOO_LONG',
      message: `Keep the question under ${MAX_KNOWLEDGE_QUESTION_CHARS} characters.`,
    });
  }

  if (answer.length === 0) {
    issues.push({ code: 'ANSWER_EMPTY', message: 'Write the answer you want texted back.' });
    return issues;
  }

  if (answer.length > MAX_KNOWLEDGE_ANSWER_CHARS) {
    issues.push({
      code: 'ANSWER_TOO_LONG',
      message:
        `This is sent as a text message, so keep it under ${MAX_KNOWLEDGE_ANSWER_CHARS} characters. ` +
        `That one is ${answer.length}.`,
    });
  }

  if (CURRENCY_CHARACTERS.test(answer) || CURRENCY_CHARACTERS.test(question)) {
    issues.push({
      code: 'ANSWER_HAS_CURRENCY',
      message:
        'Answers cannot contain prices. Add it as a service with a price instead, so the figure ' +
        'is worked out correctly and includes GST.',
    });
  } else if (!ALLOWED_ANSWER_CHARACTERS.test(answer) || !ALLOWED_ANSWER_CHARACTERS.test(question)) {
    issues.push({
      code: 'UNSUPPORTED_CHARACTERS',
      message:
        'Use letters, numbers, spaces and basic punctuation only. Emoji and special characters ' +
        'make every text message cost more to send.',
    });
  }

  return issues;
}

/**
 * Slightly wider than a service name: an answer is a sentence, so it needs terminal
 * punctuation a name never does. Still no currency, and still nothing outside GSM-7.
 */
const ALLOWED_ANSWER_CHARACTERS = /^[A-Za-z0-9 '"()\-./&,+:;!?%\n]+$/;

/** Validate the whole set, including the rules that only exist across entries. */
export function validateKnowledge(entries: readonly Partial<KnowledgeEntry>[]): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  entries.forEach((entry, index) => {
    for (const issue of validateKnowledgeEntry(entry)) {
      issues.push({ ...issue, entryId: entry.id, index });
    }
  });

  // Two entries asking the same thing is not a validation nicety: the matcher would see
  // a tie, refuse, and the caller would get nothing — so a duplicate silently disables
  // both answers.
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = cleanName(entry.question).toLowerCase().replace(/\s+/g, ' ');
    if (key.length === 0) return;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    issues.push({
      code: 'DUPLICATE_QUESTION',
      message: `You already have an answer for "${cleanName(entries[first]!.question)}". Edit that one instead.`,
      entryId: entry.id,
      index,
    });
  });

  if (entries.length > MAX_KNOWLEDGE_ENTRIES) {
    issues.push({
      code: 'TOO_MANY_ENTRIES',
      message:
        `Keep it to ${MAX_KNOWLEDGE_ENTRIES} answers. Past that, matching gets less certain and more ` +
        'questions end up going to a person instead.',
    });
  }

  return issues;
}

/**
 * Read the `businesses.knowledge` JSON column into entries, dropping anything malformed.
 *
 * **This never throws, and that is the point.** A JSON column has no schema, so the blob
 * can be any shape a past bug or a hand-run SQL statement left behind. The main reader is
 * the SMS path deciding whether it can answer a caller's question without a model call —
 * if a malformed blob threw there, one bad row would take down every conversation for
 * that business. Returning the entries it can read degrades to "we did not have an answer
 * for that", which is a state the flow already handles.
 *
 * Entries are only dropped for being *unreadable* (missing question or answer), not for
 * being invalid. A too-long or currency-carrying answer that somehow reached the column
 * still comes back, so the settings screen can show it and the owner can fix it. Blocking
 * bad answers is `validateKnowledge`'s job, at the point of writing.
 */
export function readKnowledge(value: unknown): KnowledgeEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: KnowledgeEntry[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const question = typeof row.question === 'string' ? row.question.trim() : '';
    const answer = typeof row.answer === 'string' ? row.answer.trim() : '';
    if (question.length === 0 || answer.length === 0) continue;
    entries.push({
      // An entry without an id is still usable — the id only identifies it for editing.
      id: typeof row.id === 'string' && row.id.length > 0 ? row.id : `k${entries.length}`,
      question,
      aliases: Array.isArray(row.aliases)
        ? row.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        : [],
      answer,
      sourceExcerpt: typeof row.sourceExcerpt === 'string' ? row.sourceExcerpt : undefined,
    });
  }
  return entries;
}

/** Thrown by the save path. Same shape as `CatalogueValidationError`, same reasoning. */
export class KnowledgeValidationError extends Error {
  constructor(readonly issues: readonly KnowledgeIssue[]) {
    super(`Business knowledge is invalid: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'KnowledgeValidationError';
  }
}

/** Block an invalid set at the point of writing it. */
export function assertKnowledgeValid(entries: readonly Partial<KnowledgeEntry>[]): void {
  const issues = validateKnowledge(entries);
  if (issues.length > 0) throw new KnowledgeValidationError(issues);
}
