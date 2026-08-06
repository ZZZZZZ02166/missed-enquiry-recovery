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
 * The same sign-off, for a conversation that ends with a price.
 *
 * Short because it follows one. The quote sentence has already said what the figure is
 * and what is still to be confirmed, so repeating `has your details and will confirm
 * availability` after it is both redundant to read and expensive to send — the pair came
 * to 194 characters, which is two segments on the closing message of every quoted
 * conversation. This keeps it to one.
 */
export function quotedHandoffMessage(businessName: string): string {
  const name = prepareBusinessName(businessName);
  return `Thanks. ${name} will be in touch to confirm.`;
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
 * The structured lead, texted to the owner.
 *
 * This is the product's primary owner surface (`docs/decisions.md`), not a courtesy
 * copy: a cleaner mid-job will not open a dashboard, so what fits in this message is
 * what the owner actually acts on. Hence the ordering — **the phone number is second
 * line, above every job detail**, because the useful action is ringing the customer
 * back before a competitor does.
 *
 * Written as lines rather than prose so it is scannable on a lock screen. `\n` is in
 * the GSM-7 basic set, so the layout costs nothing.
 *
 * The plan's mockup used an em dash and a middle dot. Both are outside GSM-7 and would
 * have pushed every one of these into UCS-2 — 70 characters per segment instead of
 * 160, roughly tripling the bill for decoration (rule 5). ASCII only here.
 *
 * No price appears, and there is no placeholder for one. Every currency figure comes
 * from `PriceCalculator` (rule 2), which does not exist yet.
 */
export function ownerLeadMessage(lead: OwnerLeadSummary): string {
  const lines: string[] = [];

  lines.push(lead.serviceType ? `New lead: ${lead.serviceType}` : 'New lead');

  // Name is optional; the number never is — a lead without a callback number is not
  // a lead, and the caller should read it at a glance rather than parse E.164.
  lines.push([lead.customerName, lead.customerPhoneDisplay].filter(Boolean).join(' '));

  const property = [
    lead.suburb,
    rooms(lead.bedrooms, lead.bathrooms),
    lead.carpetedRooms ? `${lead.carpetedRooms} carpeted` : null,
  ]
    .filter(Boolean)
    .join(', ');
  if (property) lines.push(property);

  if (lead.preferredDate) lines.push(`Wants: ${lead.preferredDate}`);

  // Surfaced above the gaps because it changes what the owner should do first.
  if (lead.needsHuman) {
    lines.push(lead.needsHumanReason ? `Needs you: ${lead.needsHumanReason}` : 'Needs you');
  }

  // What the conversation could not get. Turns "why is this blank?" into a question
  // the owner can ask on the call they are about to make.
  if (lead.missingFields.length > 0) {
    lines.push(`Still to confirm: ${lead.missingFields.join(', ')}`);
  }

  return normaliseToGsm7(lines.join('\n'));
}

/** What the owner template needs. Deliberately not the Prisma row — see the service. */
export interface OwnerLeadSummary {
  serviceType: string | null;
  customerName: string | null;
  /** National format, e.g. `0412 345 678`. Easier to read and to dial. */
  customerPhoneDisplay: string;
  suburb: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carpetedRooms: number | null;
  preferredDate: string | null;
  needsHuman: boolean;
  needsHumanReason: string | null;
  missingFields: string[];
}

function rooms(bedrooms: number | null, bathrooms: number | null): string | null {
  const parts: string[] = [];
  // `0` is meaningful — a studio genuinely has no bedroom — so this cannot use
  // truthiness, the same trap as everywhere else these counts are handled.
  if (bedrooms !== null) parts.push(`${bedrooms} bed`);
  if (bathrooms !== null) parts.push(`${bathrooms} bath`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Segment ceiling for the owner message.
 *
 * Unlike the caller templates this cannot be one segment — a name, a number, a
 * suburb, room counts and a date do not fit in 160 characters. Two is the realistic
 * target and three the hard stop, asserted below against a deliberately maximal lead.
 * Without a ceiling, a long service name plus a wordy date would silently drift to
 * four or five segments on every lead the business ever receives.
 */
export const MAX_OWNER_SEGMENTS = 3;

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

  // The owner message is variable-length by nature, so it is asserted against a
  // deliberately maximal lead: every field populated, long values throughout. If the
  // worst realistic case fits the budget, no real lead can exceed it.
  const worstCaseLead = ownerLeadMessage({
    serviceType: 'End of lease clean with carpet steam',
    customerName: 'Alexandra Constantinou',
    customerPhoneDisplay: '0412 345 678',
    suburb: 'Templestowe Lower',
    bedrooms: 4,
    bathrooms: 3,
    carpetedRooms: 4,
    preferredDate: 'the Wednesday after next, before midday',
    needsHuman: true,
    needsHumanReason: 'asked about price matching',
    missingFields: ['bedrooms', 'bathrooms', 'preferredDate'],
  });

  const info = segmentInfo(worstCaseLead);
  if (info.encoding !== 'GSM-7') {
    throw new Error(
      `owner lead template is ${info.encoding}, not GSM-7 — one stray character cuts the ` +
        `segment size from 160 to 70 and roughly triples the bill (CLAUDE.md rule 5). ` +
        `Offending characters: ${findNonGsm7(worstCaseLead).join(' ')}`,
    );
  }
  if (info.segments > MAX_OWNER_SEGMENTS) {
    throw new Error(
      `owner lead template is ${info.segments} segments for a worst-case lead, over the ` +
        `budget of ${MAX_OWNER_SEGMENTS}. Every lead this business receives pays this.`,
    );
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
