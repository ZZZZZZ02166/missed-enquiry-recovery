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
