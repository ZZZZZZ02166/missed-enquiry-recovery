import { assertSendable, gsm7Label } from '../common/gsm7';
import { formatCents, toGstInclusive, type PriceResult } from './price-calculator';

/**
 * The words a caller reads when the system tells them a price.
 *
 * The other half of `price-calculator.ts`. That file decides *whether* there is a
 * figure and *what* it is; this one decides how it is said. Kept apart because the
 * arithmetic must be testable without arguing about wording, and the wording must be
 * changeable without touching money.
 *
 * **Every currency figure in here comes from a `PriceResult`.** There is no parameter
 * that takes a number, no arithmetic on cents beyond re-deriving a unit rate that is
 * then checked against the total, and no way for a caller of this module to inject a
 * figure of their own. That is CLAUDE.md rule 2 expressed as an API shape rather than a
 * warning: to put a price in an outbound message you must first have obtained one from
 * `calculatePrice`.
 *
 * Pure, and asserted against the GSM-7 budget at module load.
 */

/**
 * The message, or null when nothing may be said about price.
 *
 * Null is the common, correct outcome — a manual-quote service, a missing answer, an
 * owner who does not want prices stated on their behalf. The conversation carries on
 * and the owner quotes in person.
 */
export function quoteMessage(serviceName: string, price: PriceResult): string | null {
  // Three independent reasons for silence, and all three are normal.
  if (price.amountCents === null) return null;
  if (!price.showToCustomer) return null;
  if (price.quoteType === 'NONE') return null;

  const name = gsm7Label(serviceName, MAX_NAME_IN_QUOTE);
  const total = formatCents(price.amountCents);
  const working = unitWorking(price);

  switch (price.quoteType) {
    case 'FIXED':
      // The working is shown for a firm per-unit price too, not only an estimate.
      // Pricing type and quote type are orthogonal: an owner can charge a fixed,
      // non-negotiable $40 a room, and "3 rooms at $40 = $120" is exactly the message
      // that stops that number being argued with.
      return working ? `${name}: ${working} incl. GST.` : `${name} is ${total} incl. GST.`;
    case 'FROM':
      // Never a bare number. A "from" price that reads like a quote is the one most
      // likely to be held against the owner later.
      return `${name} starts from ${total} incl. GST. The final quote is confirmed once we have your details.`;
    case 'ESTIMATE':
      return working
        ? `${name}: ${working} incl. GST. The business will confirm the final price.`
        : `${name} is around ${total} incl. GST. The business will confirm the final price.`;
  }
}

/**
 * "3 rooms at $44 = $132", or null when the arithmetic would not reconcile.
 *
 * Showing the working is worth real money — a caller who can see how a number was
 * reached argues with it less — but only if it adds up on screen.
 *
 * It cannot always. The stored rate is what the owner typed, which may be GST-exclusive,
 * and ACL's single-price rule means every figure shown to a consumer must be
 * GST-inclusive. Converting the rate and converting the total are two separate roundings
 * to the cent, so for some rates `units x incRate` lands a cent away from the total the
 * calculator produced. Rather than print an equation that is visibly wrong, or quietly
 * adjust a figure to make it look right, this returns null and the caller falls back to
 * stating the total alone.
 */
function unitWorking(price: PriceResult): string | null {
  const { units, snapshot, amountCents } = price;
  if (units === null || units <= 0 || amountCents === null) return null;
  if (snapshot.pricingType !== 'PER_UNIT') return null;
  if (snapshot.priceCents === null) return null;

  // `pricesIncludeGst` is not on the snapshot, so it is recovered from the two figures
  // the calculator already produced: if the total equals the raw rate times the units,
  // no GST was added, which means the owner's prices already included it.
  const raw = snapshot.priceCents * units;
  const alreadyIncludesGst = amountCents === raw;
  const incRate = toGstInclusive(snapshot.priceCents, alreadyIncludesGst);

  if (incRate * units !== amountCents) return null;

  const unit = unitNoun(snapshot.unitLabel, units);
  return `${units} ${unit} at ${formatCents(incRate)} = ${formatCents(amountCents)}`;
}

/** "room" -> "rooms" for anything but one. Blunt, and adequate for the words we use. */
function unitNoun(unitLabel: string | null, units: number): string {
  const base = (unitLabel ?? 'item').trim().toLowerCase() || 'item';
  if (units === 1) return base;
  return base.endsWith('s') ? base : `${base}s`;
}

/** Matches the catalogue's own limit, so a validated name is never shortened here. */
const MAX_NAME_IN_QUOTE = 32;

/**
 * Assert every wording at module load, at its worst case.
 *
 * Same reasoning as `question-flow.ts` and `service-options.ts`: a template that
 * silently costs three times as much must not be deployable, and an import cannot be
 * skipped the way a test can. The synthetic worst case is a maximum-length service name
 * with a five-figure total and a two-digit quantity — longer than anything a cleaning
 * business will produce, which is the point.
 */
const WORST_NAME = 'X'.repeat(MAX_NAME_IN_QUOTE);
const WORST_TOTAL = '$12,345.67';
for (const [label, body] of [
  ['fixed', `${WORST_NAME} is ${WORST_TOTAL} incl. GST.`],
  ['from', `${WORST_NAME} starts from ${WORST_TOTAL} incl. GST. The final quote is confirmed once we have your details.`],
  ['estimate', `${WORST_NAME} is around ${WORST_TOTAL} incl. GST. The business will confirm the final price.`],
  ['estimate with working', `${WORST_NAME}: 99 bathrooms at ${WORST_TOTAL} = ${WORST_TOTAL} incl. GST. The business will confirm the final price.`],
] as const) {
  // Two segments, matching the menu's allowance: these carry a service name the owner
  // chose plus a figure, and squeezing that into 160 characters would mean cutting the
  // qualifying words — which are the part that stops an estimate reading as a promise.
  assertSendable(body, `quote wording "${label}"`, 2);
}
