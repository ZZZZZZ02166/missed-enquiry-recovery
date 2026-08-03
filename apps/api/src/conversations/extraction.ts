import { z } from 'zod';
import type { CollectedAnswers, FieldKey } from './question-flow';

/**
 * The contract between the language model and everything downstream.
 *
 * **The model returns fields. It never returns a price, and it never returns text we
 * send.** (`CLAUDE.md` rule 2.) Both are enforced structurally here rather than by
 * instruction: the schema has no currency field and no message field, so a model that
 * tries to quote has nowhere to put the number and the value is dropped by
 * validation. An instruction can be talked around; a schema cannot.
 *
 * Everything crossing this boundary is treated as untrusted. A model asked for a
 * bedroom count will occasionally return `"two"`, `-1`, `999`, `null`, or a sentence.
 * Each of those is handled explicitly, because the alternative is a crash in a job
 * processor or a nonsense value on a lead the owner acts on.
 */

/** Plausible bounds for a residential job. Outside these, the model has misread. */
const MAX_ROOMS = 20;

/** Words people actually use instead of digits. */
const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  none: 0,
  studio: 0,
  one: 1,
  a: 1,
  single: 1,
  two: 2,
  double: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/**
 * A room count from whatever the model produced.
 *
 * Accepts a number or a string; rejects negatives, absurd values and unparseable
 * text. Returns undefined rather than throwing — a bad extraction should leave the
 * field unanswered so the conversation asks again, not abort the job.
 */
const roomCount = z
  .union([z.number(), z.string()])
  .transform((value): number | undefined => {
    if (typeof value === 'number') return Number.isInteger(value) ? value : Math.round(value);
    const trimmed = value.trim().toLowerCase();
    const word = WORD_NUMBERS[trimmed];
    if (word !== undefined) return word;
    const digits = /^(\d+)/.exec(trimmed);
    return digits?.[1] !== undefined ? Number.parseInt(digits[1], 10) : undefined;
  })
  .refine((n): n is number => n !== undefined && n >= 0 && n <= MAX_ROOMS, {
    message: `must be a room count between 0 and ${MAX_ROOMS}`,
  });

/** Free text with a length ceiling, so a model that returns a paragraph is rejected. */
const shortText = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0 && s.length <= max, { message: `must be 1-${max} characters` });

/**
 * The extraction schema.
 *
 * Every field optional: a reply that answers one thing must not fail validation
 * because it did not answer the rest. `.catch(undefined)` on each field means one bad
 * value is dropped rather than discarding the whole extraction — losing a good suburb
 * because the bedroom count was nonsense would be a poor trade.
 */
export const ExtractionSchema = z.object({
  /** Matched against the owner's service catalogue later; free text for now. */
  serviceType: shortText(60).optional().catch(undefined),
  suburb: shortText(60).optional().catch(undefined),
  propertyType: z
    .enum(['house', 'apartment', 'townhouse', 'unit', 'other'])
    .optional()
    .catch(undefined),
  bedrooms: roomCount.optional().catch(undefined),
  bathrooms: roomCount.optional().catch(undefined),
  carpetedRooms: roomCount.optional().catch(undefined),
  /** Kept as the customer's own words. Date parsing is a separate concern. */
  preferredDate: shortText(60).optional().catch(undefined),
  name: shortText(60).optional().catch(undefined),

  /**
   * Signals, not answers. These change how we respond, never what we quote.
   */
  urgency: z.enum(['low', 'normal', 'high']).optional().catch(undefined),
  /** The model's own assessment that a human should take over. Advisory. */
  requiresHuman: z.boolean().optional().catch(undefined),
  /** Free-text reason, shown to the owner. Never sent to the customer. */
  requiresHumanReason: shortText(120).optional().catch(undefined),
});

export type ExtractionResult = z.infer<typeof ExtractionSchema>;

/**
 * Fields that become answers. Signals are deliberately excluded — `urgency` is not
 * something the conversation asks about, and letting it into `collected` would make
 * it look like a satisfied question.
 */
const ANSWER_FIELDS: readonly FieldKey[] = [
  'serviceType',
  'suburb',
  'propertyType',
  'bedrooms',
  'bathrooms',
  'carpetedRooms',
  'preferredDate',
  'name',
] as const;

/**
 * Keys a model must never be able to influence.
 *
 * A model told to return JSON will sometimes return extra keys — including ones it
 * has inferred are meaningful. Stripping them by allowlist rather than blocklist
 * means a field invented tomorrow is ignored by default.
 */
export interface ParsedExtraction {
  answers: CollectedAnswers;
  urgency?: 'low' | 'normal' | 'high';
  requiresHuman: boolean;
  requiresHumanReason?: string;
  /** Keys the model returned that we do not accept. Logged, never stored. */
  rejected: string[];
}

/**
 * Validate and narrow a raw model response.
 *
 * Never throws. A model that returns garbage, a string, null, or a price should
 * produce an empty extraction and a logged rejection — not an exception inside a job
 * that then retries four more times against the same garbage.
 */
export function parseExtraction(raw: unknown): ParsedExtraction {
  const empty: ParsedExtraction = { answers: {}, requiresHuman: false, rejected: [] };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...empty, rejected: ['<non-object response>'] };
  }

  const result = ExtractionSchema.safeParse(raw);
  if (!result.success) {
    // With `.catch(undefined)` on every field this should be unreachable, but a
    // schema change could reintroduce a hard failure — and dropping the extraction
    // is better than throwing inside a processor.
    return { ...empty, rejected: ['<schema rejected>'] };
  }

  const allowed = new Set<string>([
    ...ANSWER_FIELDS,
    'urgency',
    'requiresHuman',
    'requiresHumanReason',
  ]);
  const rejected = Object.keys(raw as Record<string, unknown>).filter((k) => !allowed.has(k));

  const answers: CollectedAnswers = {};
  for (const key of ANSWER_FIELDS) {
    const value = result.data[key];
    if (value !== undefined) answers[key] = value;
  }

  return {
    answers,
    urgency: result.data.urgency,
    requiresHuman: result.data.requiresHuman === true,
    requiresHumanReason: result.data.requiresHumanReason,
    rejected,
  };
}

/**
 * Merge new answers over existing ones.
 *
 * Later answers win — a customer correcting themselves ("sorry, 3 bedrooms not 2")
 * must overwrite. But an *absent* field never clears a known one: an extraction that
 * simply did not mention the suburb is silence, not a retraction.
 */
export function mergeAnswers(
  existing: CollectedAnswers,
  incoming: CollectedAnswers,
): CollectedAnswers {
  const merged: CollectedAnswers = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key as FieldKey] = value;
    }
  }
  return merged;
}

/**
 * A currency figure anywhere in a model's response means the prompt has drifted or
 * the model is improvising a quote. Detected so it can be logged loudly — rule 2 is
 * enforced by the schema, but silent enforcement teaches nobody.
 */
export function containsCurrency(raw: unknown): boolean {
  return /[$£€]|\bAUD\b|\b\d+\s?(dollars|cents)\b/i.test(JSON.stringify(raw ?? ''));
}
