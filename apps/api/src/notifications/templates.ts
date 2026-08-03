import {
  assertSendable,
  findNonGsm7,
  normaliseToGsm7,
  segmentInfo,
  type SegmentInfo,
} from '../common/gsm7';

/**
 * Outbound SMS copy.
 *
 * Every template here is subject to constraints that are not stylistic:
 *
 *   Spam Act      Business name in the first ~25 characters (sender identification),
 *                 opt-out notice on the first message, and NO marketing content —
 *                 no offers, no discounts, no promotions, ever. That last rule is
 *                 what keeps these messages arguably outside "commercial electronic
 *                 message" territory (docs/compliance.md §1, CLAUDE.md rule 10).
 *
 *   Cost          GSM-7 only, one segment. A curly apostrophe triples the bill
 *                 (CLAUDE.md rule 5). Enforced below, at module load.
 *
 *   Pricing       No currency figure may appear in any template. Every price comes
 *                 from PriceCalculator at send time (CLAUDE.md rule 2). There is
 *                 deliberately no `{price}` placeholder here.
 *
 * Templates are functions rather than format strings so the business name is
 * interpolated where it belongs and the result can be asserted as a whole — a
 * 158-character template plus a 30-character business name is two segments, and only
 * checking the template would miss it.
 */

/**
 * Longest business name we guarantee fits in one segment.
 *
 * Names longer than this are truncated rather than allowed to push the message into
 * a second segment. Truncation is visible and cheap; a silent doubling of every
 * message's cost is neither.
 */
export const MAX_BUSINESS_NAME = 32;

/** Reserved for the opt-out notice. Required on the first message only. */
const OPT_OUT = 'Reply STOP to opt out.';

/**
 * Prepare a business name for interpolation into an outbound message.
 *
 * Three steps, in order:
 *
 *  1. Normalise what people paste — curly quotes in "Dave's Cleaning" become
 *     straight ones, so an invisible character cannot triple the bill.
 *  2. **Strip anything still unsendable** — an emoji, CJK — because the alternative
 *     is throwing at send time, and a caller who has just been promised a text
 *     would receive nothing at all. Names are rejected at input by
 *     `validateBusinessName`; this is the fallback for data that predates that
 *     check, and losing a lead is worse than a slightly shortened name.
 *  3. Truncate to one segment.
 *
 * Callers that can log should use `prepareBusinessNameVerbose` instead — silently
 * degrading is how a mangled name goes unnoticed for months.
 */
export function prepareBusinessName(name: string): string {
  return prepareBusinessNameVerbose(name).name;
}

/**
 * As `prepareBusinessName`, but reports what had to be removed.
 *
 * `stripped` non-empty means a business is sending messages under a name that is not
 * quite theirs — recoverable, but the owner should be told rather than left to
 * discover it in a customer's inbox.
 */
export function prepareBusinessNameVerbose(name: string): {
  name: string;
  stripped: string[];
  truncated: boolean;
} {
  const normalised = normaliseToGsm7(name.trim());
  const stripped = findNonGsm7(normalised);
  const sendable = stripped.length === 0 ? normalised : stripNonGsm7(normalised, stripped);

  if (sendable.length <= MAX_BUSINESS_NAME) {
    return { name: sendable, stripped, truncated: false };
  }
  return {
    name: `${sendable.slice(0, MAX_BUSINESS_NAME - 1).trimEnd()}.`,
    stripped,
    truncated: true,
  };
}

/**
 * Remove the given characters and tidy the gaps they leave.
 *
 * Local to this module rather than imported from `businesses/business-name.ts`:
 * templates must not depend on the businesses domain, and this direction of
 * dependency would make the assertion at the bottom of this file transitively
 * import a validator that imports these templates back.
 */
function stripNonGsm7(text: string, offenders: string[]): string {
  const remove = new Set(offenders);
  let out = '';
  for (const char of text) {
    if (!remove.has(char)) out += char;
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * The first message, sent within ~60 seconds of a missed call.
 *
 * Design constraints, in order of importance:
 *
 *  - The business name comes **first**. It is both the Spam Act's sender
 *    identification and the caller's only signal that a text from an unknown number
 *    is legitimate — they were told to expect it by the voice greeting seconds ago.
 *  - It asks **one open question**, not a list. Six sequential questions lose most
 *    people by the third, and each abandoned conversation still costs money.
 *  - It states no price and makes no offer.
 */
export function recoveryFirstMessage(businessName: string): string {
  const name = prepareBusinessName(businessName);
  return `${name}: sorry we missed your call. What do you need help with, and which suburb are you in? ${OPT_OUT}`;
}

/**
 * Variant for a caller we already know — an existing customer or a known contact.
 *
 * Asking "what do you need?" when someone is ringing about a job already booked is
 * jarring and reads as automated. This says a human will call back and gets out of
 * the way.
 */
export function recoveryKnownContactMessage(businessName: string): string {
  const name = prepareBusinessName(businessName);
  return `${name}: sorry we missed your call. We will ring you back shortly. Reply here if it is urgent. ${OPT_OUT}`;
}

/**
 * Sent when the caller has answered everything the business needs.
 *
 * Deliberately does not promise a time, a price, or availability — none of which we
 * know. Promising any of them on the business's behalf is a representation we cannot
 * stand behind.
 */
export function recoveryHandoffMessage(businessName: string): string {
  const name = prepareBusinessName(businessName);
  return `Thanks. ${name} has your details and will confirm availability with you shortly.`;
}

/**
 * A single nudge after silence. Off by default, business-hours aware.
 *
 * One only. A second nudge to someone who has ignored the first is the point at which
 * a transactional reply starts to look like marketing.
 */
export function recoveryNudgeMessage(businessName: string): string {
  const name = prepareBusinessName(businessName);
  return `${name}: still happy to help with your enquiry - just reply here with what you need.`;
}

/**
 * All caller-facing templates, with a representative name for assertion.
 *
 * The name used here is deliberately at `MAX_BUSINESS_NAME`, so the check is against
 * the worst legitimate case rather than a short example that hides the boundary.
 */
const WORST_CASE_NAME = 'A'.repeat(MAX_BUSINESS_NAME);

export const CALLER_TEMPLATES: Record<string, (businessName: string) => string> = {
  recoveryFirstMessage,
  recoveryKnownContactMessage,
  recoveryHandoffMessage,
  recoveryNudgeMessage,
};

/**
 * Assert every template at module load.
 *
 * Deliberately at import time, not in a test. A template that would cost three times
 * as much, or that dropped the opt-out notice, must not be deployable at all — and
 * this runs in CI, in dev, and at boot in production. A test can be skipped; an
 * import cannot.
 *
 * The cost of getting this wrong is silent and recurring, which is exactly the shape
 * of failure that deserves a boot-time guard rather than a warning.
 */
function assertAllTemplates(): void {
  for (const [name, template] of Object.entries(CALLER_TEMPLATES)) {
    assertSendable(template(WORST_CASE_NAME), `template ${name} (worst-case business name)`);
  }
}

assertAllTemplates();

/** Segment and encoding detail for a template — used by tests and cost reporting. */
export function inspectTemplate(
  template: (businessName: string) => string,
  businessName: string = WORST_CASE_NAME,
): SegmentInfo {
  return segmentInfo(template(businessName));
}
