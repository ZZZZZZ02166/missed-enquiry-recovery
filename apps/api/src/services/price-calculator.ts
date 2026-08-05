import type { PriceConfidence, PricingType, ServiceAvailability } from '../generated/prisma/client';

/**
 * The only thing in this system permitted to produce a currency figure.
 *
 * CLAUDE.md rule 2 in executable form. The model returns `{ serviceId, fieldValues }`
 * and never a number — it is not even shown the prices, so a figure it never saw is
 * one it cannot improvise. Everything a caller is told about money is computed here,
 * from the owner's stored configuration, by deterministic code with no network call
 * and no judgement.
 *
 * Pure and dependency-free on purpose. Money is the part where a subtle bug is a
 * refund and a complaint rather than a stack trace, so it has to be testable
 * exhaustively without a database, a queue or a model.
 */

/** GST, as a proportion. Australia, 10%, and stable for twenty-five years. */
const GST_RATE = 0.1;

/** The subset of a `Service` row pricing actually reads. */
export interface PricingConfig {
  id: string;
  name: string;
  pricingType: PricingType;
  priceCents: number | null;
  unitLabel: string | null;
  minUnits: number | null;
  maxUnits: number | null;
  showPriceAutomatically: boolean;
  priceConfidence: PriceConfidence;
  requiresConfirmation: boolean;
  requiredFields: string[];
  availability: ServiceAvailability;
}

/** Answers collected so far, by field key. Values are whatever extraction produced. */
export type PricingAnswers = Record<string, unknown>;

/** Why a price could not be produced. Each maps to different owner-facing wording. */
export type NoPriceReason =
  | 'MANUAL_QUOTE'
  | 'SERVICE_UNAVAILABLE'
  | 'MISSING_ANSWERS'
  | 'QUANTITY_OUT_OF_RANGE'
  | 'NOT_CONFIGURED';

export type QuoteType = 'FIXED' | 'ESTIMATE' | 'FROM' | 'NONE';

export interface PriceResult {
  /** Computed, GST-inclusive, integer cents. Null when no figure could be produced. */
  amountCents: number | null;
  quoteType: QuoteType;
  /**
   * Whether this figure may be said to the caller.
   *
   * Deliberately separate from having computed one: an owner can want the number on
   * the lead without it being promised on their behalf. False here with a non-null
   * amount is a valid, meaningful state.
   */
  showToCustomer: boolean;
  /** Populated only when `amountCents` is null. */
  reason: NoPriceReason | null;
  /** Field keys still needed before this service can be priced. */
  missingFields: string[];
  /** For `PER_UNIT`: the quantity used, so the message can show the arithmetic. */
  units: number | null;
  /**
   * The configuration exactly as it stood at this moment, for `leads.quoteSnapshot`.
   *
   * When the owner raises prices next month, what the customer was told must not
   * change with them.
   */
  snapshot: PricingConfig & { gstRate: number; computedAt: string };
}

/**
 * Compute the price for a service, given what the conversation knows.
 *
 * Never throws and never guesses. Every path that cannot produce a defensible figure
 * returns `amountCents: null` with a reason — falling through to a manual quote is
 * always available, and is always better than a number the owner will not honour.
 */
export function calculatePrice(
  service: PricingConfig,
  answers: PricingAnswers,
  options: { pricesIncludeGst: boolean },
): PriceResult {
  const snapshot = { ...service, gstRate: GST_RATE, computedAt: new Date().toISOString() };
  const none = (reason: NoPriceReason, missingFields: string[] = []): PriceResult => ({
    amountCents: null,
    quoteType: 'NONE',
    showToCustomer: false,
    reason,
    missingFields,
    units: null,
    snapshot,
  });

  // A service the owner has turned off must never be matched or quoted — including
  // one that is only temporarily unavailable, where quoting would promise work that
  // cannot be done this month.
  if (service.availability !== 'ACTIVE') return none('SERVICE_UNAVAILABLE');

  if (service.pricingType === 'MANUAL_QUOTE') return none('MANUAL_QUOTE');

  // A priced type with no price is a half-finished catalogue entry, not a free job.
  if (service.priceCents === null || service.priceCents < 0) return none('NOT_CONFIGURED');

  // Nothing is priced until every answer the owner said they needed is in. Quoting a
  // per-room rate without knowing the rooms is how a caller is told a number that is
  // then withdrawn.
  const missing = service.requiredFields.filter((key) => !hasAnswer(answers, key));
  if (missing.length > 0) return none('MISSING_ANSWERS', missing);

  if (service.pricingType === 'FIXED' || service.pricingType === 'STARTING_FROM') {
    const amountCents = toGstInclusive(service.priceCents, options.pricesIncludeGst);
    return {
      amountCents,
      quoteType: quoteTypeFor(service),
      showToCustomer: service.showPriceAutomatically,
      reason: null,
      missingFields: [],
      units: null,
      snapshot,
    };
  }

  // PER_UNIT.
  const units = unitCount(answers, service.unitLabel);
  if (units === null) {
    // The unit field itself is the missing answer, even when the owner did not list
    // it — a rate cannot be multiplied by an unknown.
    return none('MISSING_ANSWERS', [service.unitLabel ?? 'quantity']);
  }
  // Out of range is not clamped. Clamping "12 rooms" to a maximum of 8 would quote a
  // number for work nobody described; asking again is the only honest response.
  if (service.minUnits !== null && units < service.minUnits) {
    return none('QUANTITY_OUT_OF_RANGE');
  }
  if (service.maxUnits !== null && units > service.maxUnits) {
    return none('QUANTITY_OUT_OF_RANGE');
  }

  const amountCents = toGstInclusive(service.priceCents * units, options.pricesIncludeGst);
  return {
    amountCents,
    quoteType: quoteTypeFor(service),
    showToCustomer: service.showPriceAutomatically,
    reason: null,
    missingFields: [],
    units,
    snapshot,
  };
}

/**
 * How the figure should be read, and therefore worded.
 *
 * `requiresConfirmation` downgrades a firm price to an estimate rather than
 * suppressing it: the caller still gets a number, and the wording says the business
 * will confirm. Silence would lose the job; an unqualified promise the owner has not
 * agreed to would be worse.
 */
function quoteTypeFor(service: PricingConfig): QuoteType {
  if (service.pricingType === 'STARTING_FROM') return 'FROM';
  if (service.requiresConfirmation) return 'ESTIMATE';
  return service.priceConfidence === 'FIRM' ? 'FIXED' : 'ESTIMATE';
}

/**
 * Convert to the GST-inclusive figure the caller must see.
 *
 * Australian Consumer Law's single-price rule: a price quoted to a consumer includes
 * GST, whatever the owner typed into their settings. This is real exposure, not a
 * nicety, and it is why the conversion lives here rather than being left to whoever
 * writes the message.
 *
 * Rounds half-up to the cent. A half-cent is not payable, and rounding down would
 * quote a figure fractionally under the GST-inclusive price.
 */
export function toGstInclusive(cents: number, alreadyIncludesGst: boolean): number {
  if (alreadyIncludesGst) return Math.round(cents);
  return Math.round(cents * (1 + GST_RATE));
}

/**
 * The quantity for a `PER_UNIT` service.
 *
 * Reads the answer whose key matches the unit label — `carpetedRooms` for a service
 * priced per "room", `hours` for one priced per "hour". Falls back to a plain
 * `quantity` answer so an owner can price per unit without adopting a field name.
 */
function unitCount(answers: PricingAnswers, unitLabel: string | null): number | null {
  const candidates = [unitLabel ? unitFieldFor(unitLabel) : null, 'quantity', 'units'].filter(
    (k): k is string => k !== null,
  );

  for (const key of candidates) {
    const value = answers[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  }
  return null;
}

/** "room" -> `carpetedRooms`, "hour" -> `hours`. The vocabulary the flow collects. */
function unitFieldFor(unitLabel: string): string {
  const normalised = unitLabel.trim().toLowerCase();
  if (normalised.startsWith('room')) return 'carpetedRooms';
  if (normalised.startsWith('hour')) return 'hours';
  if (normalised.startsWith('bedroom')) return 'bedrooms';
  if (normalised.startsWith('bathroom')) return 'bathrooms';
  return normalised;
}

/** True when a field has a usable answer. `0` counts; an empty string does not. */
function hasAnswer(answers: PricingAnswers, key: string): boolean {
  const value = answers[key];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/** Integer cents to the figure a person reads. `28000` -> `"$280"`, `28050` -> `"$280.50"`. */
export function formatCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
