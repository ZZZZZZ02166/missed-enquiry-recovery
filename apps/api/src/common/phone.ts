import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone normalisation. Applied at every ingress point — Twilio webhooks, dashboard
 * input, CSV import — before anything else touches the value.
 *
 * Everything downstream depends on this: `@@unique([businessId, phoneE164])` only
 * means something if every writer normalised first, and a suppression list keyed on
 * a raw string silently fails to suppress. (CLAUDE.md rule 6.)
 */

/**
 * Values carriers use for a withheld or unavailable caller ID. Twilio passes these
 * through in `From`. They are a valid state, not an error: record the call, skip the
 * SMS. Compared case-insensitively after stripping non-alphanumerics.
 */
const ANONYMOUS_MARKERS = new Set([
  'anonymous',
  'unknown',
  'private',
  'restricted',
  'unavailable',
  'withheld',
  // Some carriers signal a withheld number with this reserved sequence rather than
  // a text marker.
  '266696687',
]);

/**
 * Normalise to E.164, defaulting to Australia.
 *
 * Returns null for anything unusable — empty, withheld, or not a valid number. The
 * caller decides what that means; this function does not throw, because an
 * unparseable caller ID is an expected daily occurrence, not an exception.
 */
export function toE164(
  input: string | null | undefined,
  defaultCountry = 'AU' as const,
): string | null {
  if (!input) return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (isAnonymous(trimmed)) return null;

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;

  return parsed.number;
}

/** True when the value represents a withheld or unavailable caller ID. */
export function isAnonymous(input: string | null | undefined): boolean {
  if (!input) return true;
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return key.length === 0 || ANONYMOUS_MARKERS.has(key);
}

/**
 * Australian national format for display only — `0412 345 678`.
 *
 * Never use this for `tel:` or `sms:` hrefs, or for storage. National format breaks
 * when the handset is roaming; E.164 does not. (.claude/skills/frontend/SKILL.md §6.)
 */
export function toNationalDisplay(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.formatNational() ?? e164;
}

/** True when the number is an Australian mobile — the only line type that can receive SMS. */
export function isAustralianMobile(e164: string): boolean {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || parsed.country !== 'AU') return false;
  return parsed.getType() === 'MOBILE';
}
