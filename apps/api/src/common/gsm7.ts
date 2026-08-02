/**
 * GSM-7 charset validation and SMS segment counting.
 *
 * Twilio bills per **segment**, not per message, and the encoding decides how big a
 * segment is:
 *
 *   GSM-7   160 chars single, 153 per segment when concatenated
 *   UCS-2    70 chars single,  67 per segment when concatenated
 *
 * One non-GSM-7 character switches the *entire* message to UCS-2. A curly apostrophe
 * pasted from a document — `’` instead of `'` — turns a 1-segment message into 3.
 * That is a 200% cost increase on every send, applied silently, and it is the single
 * easiest way to inflate the SMS bill (CLAUDE.md rule 5).
 *
 * This module makes that assertable in CI rather than hoping nobody pastes.
 */

/**
 * The GSM 03.38 basic character set.
 *
 * Written as an explicit set rather than a regex range because the set is not
 * contiguous in Unicode and a range would quietly admit characters that are not in
 * it — which is exactly the failure being prevented.
 */
const GSM7_BASIC = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ',
    ' !"#¤%&\'()*+,-./0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§',
    '¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ]
    .join('')
    .split(''),
);

/**
 * Characters reachable only via an escape sequence. Each costs **two** septets, so a
 * message full of them hits the segment limit at half the apparent length.
 */
const GSM7_EXTENDED = new Set(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

const SINGLE_GSM7 = 160;
const CONCAT_GSM7 = 153;
const SINGLE_UCS2 = 70;
const CONCAT_UCS2 = 67;

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Septets for GSM-7 (extended characters count as 2), UTF-16 code units for UCS-2. */
  length: number;
  segments: number;
  /** Characters that forced UCS-2. Empty when the message is GSM-7. */
  offenders: string[];
}

/** True when every character is representable in GSM-7. */
export function isGsm7(text: string): boolean {
  for (const char of text) {
    if (!GSM7_BASIC.has(char) && !GSM7_EXTENDED.has(char)) return false;
  }
  return true;
}

/**
 * The characters that would force UCS-2, de-duplicated and in order of appearance.
 *
 * Returned rather than a bare boolean because the useful error message is *which*
 * character — "contains ’ (U+2019)" tells someone what to fix; "not GSM-7" does not.
 */
export function findNonGsm7(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const char of text) {
    if (GSM7_BASIC.has(char) || GSM7_EXTENDED.has(char)) continue;
    if (seen.has(char)) continue;
    seen.add(char);
    found.push(char);
  }
  return found;
}

/**
 * Encoding, length and segment count for a message.
 *
 * Iterates by code point, not by `.length`: an emoji is a surrogate pair, so
 * `'👍'.length === 2`. Counting UTF-16 units would be right for UCS-2 billing but
 * wrong for identifying characters, so both are computed deliberately.
 */
export function segmentInfo(text: string): SegmentInfo {
  const offenders = findNonGsm7(text);

  if (offenders.length === 0) {
    let septets = 0;
    for (const char of text) septets += GSM7_EXTENDED.has(char) ? 2 : 1;
    return {
      encoding: 'GSM-7',
      length: septets,
      segments: countSegments(septets, SINGLE_GSM7, CONCAT_GSM7),
      offenders,
    };
  }

  // UCS-2 is billed per UTF-16 code unit, so a surrogate pair costs two.
  const units = text.length;
  return {
    encoding: 'UCS-2',
    length: units,
    segments: countSegments(units, SINGLE_UCS2, CONCAT_UCS2),
    offenders,
  };
}

function countSegments(length: number, single: number, concat: number): number {
  // An empty body is still one message on the wire, and Twilio bills it.
  if (length === 0) return 1;
  if (length <= single) return 1;
  return Math.ceil(length / concat);
}

/** Convenience for the common assertion. */
export function segmentCount(text: string): number {
  return segmentInfo(text).segments;
}

export class Gsm7ViolationError extends Error {
  constructor(
    readonly offenders: string[],
    context: string,
  ) {
    const detail = offenders
      .map(
        (c) =>
          `${JSON.stringify(c)} (U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')})`,
      )
      .join(', ');
    super(
      `${context}: message contains non-GSM-7 characters and would be billed as UCS-2 ` +
        `(70 chars per segment instead of 160). Offending: ${detail}. ` +
        `Replace curly quotes with straight ones and remove emoji.`,
    );
    this.name = 'Gsm7ViolationError';
  }
}

/**
 * Throw unless the message is GSM-7 and within `maxSegments`.
 *
 * Intended for template tests and for the send path. Throwing rather than returning
 * a boolean is deliberate: a message that silently triples in cost is worse than one
 * that fails loudly in CI, and there is no sensible "carry on" behaviour.
 */
export function assertSendable(text: string, context: string, maxSegments = 1): SegmentInfo {
  const info = segmentInfo(text);

  if (info.offenders.length > 0) {
    throw new Gsm7ViolationError(info.offenders, context);
  }
  if (info.segments > maxSegments) {
    throw new Error(
      `${context}: message is ${info.segments} segments (${info.length} chars), ` +
        `limit is ${maxSegments}. Each extra segment is billed separately.`,
    );
  }

  return info;
}

/**
 * Replace the characters that most often sneak in from a word processor or a
 * copy-pasted brief, leaving anything else to fail loudly.
 *
 * Deliberately narrow. A general "strip everything unrepresentable" would quietly
 * mangle a business name — `Café Cleaning` becoming `Caf Cleaning` in every message
 * is worse than a template test failing once, because nobody sees it until a customer
 * does.
 */
export function normaliseToGsm7(text: string): string {
  return (
    text
      .replace(/[‘’‛]/g, "'") // ' ' ‛ → '
      .replace(/[“”‟]/g, '"') // " " ‟ → "
      .replace(/[–—]/g, '-') // – — → -
      .replace(/…/g, '...') // … → ...
      // Escape, not a literal: a literal non-breaking space is invisible in a diff,
      // and ESLint's no-irregular-whitespace rejects it — correctly, since this file
      // exists to stop invisible characters costing money.
      .replace(/\u00a0/g, ' ')
  );
}
