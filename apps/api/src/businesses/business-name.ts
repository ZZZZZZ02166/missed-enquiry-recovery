import { findNonGsm7, normaliseToGsm7, segmentInfo } from '../common/gsm7';
import {
  MAX_BUSINESS_NAME,
  prepareBusinessNameVerbose,
  recoveryFirstMessage,
} from '../notifications/templates';

/**
 * Business name validation.
 *
 * The name is interpolated into every SMS a business sends, so a character that
 * cannot be encoded in GSM-7 is not a cosmetic problem — it doubles or triples the
 * cost of every message, and if the send path refuses it, **every recovery SMS for
 * that business fails and every lead is lost**.
 *
 * The fix is to catch it at the only moment where nobody is harmed: when the owner
 * types it. They get a specific error naming the character, and correct it before a
 * single customer is affected.
 *
 * This module is the source of truth for that check. The dashboard calls it through
 * the API and shows the message verbatim; the send path uses `businessNameForSms` as
 * a last-resort fallback for names that predate validation.
 */

export type BusinessNameProblem = 'EMPTY' | 'TOO_LONG' | 'UNSENDABLE_CHARACTERS';

export interface BusinessNameValidation {
  ok: boolean;
  problem?: BusinessNameProblem;
  /** Shown to the owner verbatim. Written for a person, not a log. */
  message?: string;
  /** The exact characters to remove, so the UI can highlight them. */
  offenders?: string[];
  /** The name as it would be stored — trimmed, curly quotes straightened. */
  normalised: string;
}

/**
 * Describe a character in a way a non-technical owner can act on.
 *
 * "U+1F9FC" means nothing to a cleaner. Showing the character itself is what lets
 * them find it in the box they just typed into.
 */
function describe(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  // Emoji live in the supplementary planes; naming them "emoji" is more useful than
  // "special character" because it tells the owner exactly what to look for.
  const isEmoji = code > 0xffff || (code >= 0x2600 && code <= 0x27bf);
  return isEmoji ? `${char} (emoji)` : `${char}`;
}

/**
 * Validate a business name for use in SMS.
 *
 * Accepts accented Latin characters — `é`, `ñ`, `ü`, `à` are all in GSM-7, so
 * "Café Cleaning" is perfectly sendable and must not be rejected. Only characters
 * that genuinely cannot be encoded are refused, which keeps the error honest: an
 * owner told "special characters aren't allowed" while `Café` works fine would
 * rightly lose trust in the message.
 */
export function validateBusinessName(input: string): BusinessNameValidation {
  // Straighten curly quotes first. Someone pasting "Dave's Cleaning" from a document
  // should not be told their apostrophe is illegal — it is fixable and unambiguous.
  const normalised = normaliseToGsm7(input.trim());

  if (normalised.length === 0) {
    return {
      ok: false,
      problem: 'EMPTY',
      message: 'Enter your business name.',
      normalised,
    };
  }

  const offenders = findNonGsm7(normalised);
  if (offenders.length > 0) {
    const list = offenders.map(describe).join(', ');
    const cleaned = stripToGsm7(normalised).trim();
    return {
      ok: false,
      problem: 'UNSENDABLE_CHARACTERS',
      message:
        `${list} cannot be sent in a text message. ` +
        `Please remove it — your name would need to be "${cleaned}".`,
      offenders,
      normalised,
    };
  }

  if (normalised.length > MAX_BUSINESS_NAME) {
    return {
      ok: false,
      problem: 'TOO_LONG',
      message:
        `Business name is ${normalised.length} characters. ` +
        `Please shorten it to ${MAX_BUSINESS_NAME} or fewer so it fits in one text message.`,
      normalised,
    };
  }

  return { ok: true, normalised };
}

/**
 * Remove characters that cannot be sent, for use at the send boundary only.
 *
 * Deliberately separate from `normaliseToGsm7`, which *substitutes* (curly quote →
 * straight) and never deletes. This one deletes, which is why it is named for what
 * it does and is not reachable by accident.
 *
 * Only ever a fallback. A name that reaches this function should have been rejected
 * at input; if it was not, losing a lead is worse than a slightly mangled name.
 */
export function stripToGsm7(text: string): string {
  const offenders = new Set(findNonGsm7(text));
  if (offenders.size === 0) return text;

  let out = '';
  for (const char of text) {
    if (!offenders.has(char)) out += char;
  }
  // Deleting a character often leaves a double space or a trailing one.
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * The name to interpolate into an outbound SMS.
 *
 * Delegates to `prepareBusinessNameVerbose`, which is what the templates themselves
 * call. Two implementations of "make this name sendable" would eventually disagree,
 * and the one the send path actually uses is the one that must be right — so this is
 * a thin alias rather than a parallel copy.
 */
export function businessNameForSms(name: string): {
  name: string;
  stripped: string[];
  truncated: boolean;
} {
  return prepareBusinessNameVerbose(name);
}

/**
 * Preview what a caller will actually receive, for the onboarding screen.
 *
 * An owner should see the real message and its cost before their first customer
 * does — including that a 40-character name is being truncated. Discovering it in a
 * customer's inbox is the failure this prevents.
 */
export function previewRecoveryMessage(businessName: string): {
  message: string;
  segments: number;
  truncated: boolean;
} {
  const { name } = businessNameForSms(businessName);
  const message = recoveryFirstMessage(name);
  return {
    message,
    segments: segmentInfo(message).segments,
    truncated: name.length > MAX_BUSINESS_NAME,
  };
}
