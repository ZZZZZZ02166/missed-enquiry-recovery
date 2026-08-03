import { assertSendable } from '../common/gsm7';

/**
 * The qualification question set.
 *
 * Two rules shape everything here:
 *
 *   1. **Ask as few questions as possible.** Six sequential questions lose most
 *      people by the third, and every abandoned conversation still costs money. The
 *      first message asks one open question and extraction pulls several fields from
 *      the free-text answer; this file only supplies what is *still* missing.
 *
 *   2. **Never ask what we already know.** `nextQuestion` is driven by the collected
 *      answers, not by a fixed sequence — someone who writes "2 bed 2 bath end of
 *      lease in Southbank next Tuesday" should be asked nothing further.
 *
 * Owner-configurable question sets are a later step. This is the default flow, and
 * the shape it defines — required fields, one prompt each — is what a stored
 * configuration will have to satisfy.
 */

/**
 * A field the conversation can collect.
 *
 * Kept as a closed union rather than free strings: `awaitingField` is persisted, and
 * a typo in a field name would silently create a question nobody can ever answer.
 */
export type FieldKey =
  | 'serviceType'
  | 'suburb'
  | 'propertyType'
  | 'bedrooms'
  | 'bathrooms'
  | 'preferredDate'
  | 'carpetedRooms'
  | 'name';

export interface QuestionDefinition {
  key: FieldKey;
  /** Asked when this field is the one outstanding. Must be one GSM-7 segment. */
  prompt: string;
  /**
   * Whether the conversation can complete without it.
   *
   * Deliberately few required fields. Every `required: true` is a chance for someone
   * to stop replying, and the owner can ring back for the rest — an incomplete lead
   * with a phone number beats a perfect one that was never finished.
   */
  required: boolean;
}

/**
 * Ordered by what the business needs first, not by what is easiest to ask.
 *
 * Service and suburb come first because they decide whether the job is even in scope
 * — a business that does not clean in Geelong should find out before asking about
 * bedrooms.
 */
export const DEFAULT_QUESTIONS: readonly QuestionDefinition[] = [
  {
    key: 'serviceType',
    prompt: 'What type of cleaning do you need? For example end of lease, regular, or one off.',
    required: true,
  },
  {
    key: 'suburb',
    prompt: 'Which suburb is the property in?',
    required: true,
  },
  {
    key: 'bedrooms',
    prompt: 'How many bedrooms and bathrooms does the property have?',
    required: true,
  },
  {
    key: 'preferredDate',
    prompt: 'What date would you like the work done?',
    required: true,
  },
  {
    key: 'propertyType',
    prompt: 'Is it a house, apartment, or townhouse?',
    required: false,
  },
  {
    key: 'carpetedRooms',
    prompt: 'How many carpeted rooms need cleaning?',
    required: false,
  },
  {
    key: 'name',
    prompt: 'Last thing - what name should we put the booking under?',
    required: false,
  },
] as const;

/**
 * Hard ceiling on questions per conversation.
 *
 * Not a target — a limit. Reaching it means extraction is failing, and the right
 * response is to hand a partial lead to the owner rather than keep texting someone
 * who is plainly not answering what we asked.
 */
export const MAX_QUESTIONS = 5;

/** Answers collected so far. Values are whatever extraction produced. */
export type CollectedAnswers = Partial<Record<FieldKey, unknown>>;

/** True when a field has a usable answer — not merely a present key. */
export function hasAnswer(collected: CollectedAnswers, key: FieldKey): boolean {
  const value = collected[key];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * `bedrooms` and `bathrooms` are asked in one breath because that is how people
 * say it — "two bed two bath". Treating them as separate questions would double the
 * round trips for one piece of information.
 */
const PAIRED_WITH: Partial<Record<FieldKey, FieldKey>> = { bedrooms: 'bathrooms' };

/**
 * The next question to ask, or null when there is nothing left worth asking.
 *
 * Returns null in three distinct situations, and the caller must tell them apart:
 * every required field answered (complete), the question ceiling reached (hand over
 * partial), or nothing optional left (complete).
 */
export function nextQuestion(
  collected: CollectedAnswers,
  questionsAsked: number,
  questions: readonly QuestionDefinition[] = DEFAULT_QUESTIONS,
): QuestionDefinition | null {
  if (questionsAsked >= MAX_QUESTIONS) return null;

  // Required first, in order, so a conversation that stops early still yields the
  // most valuable fields.
  const missingRequired = questions.find((q) => q.required && !hasAnswer(collected, q.key));
  if (missingRequired) return missingRequired;

  // Only chase optional fields while the conversation is clearly still cheap — an
  // extra question to someone who has answered everything required risks the reply
  // that never comes, for information the owner can ask on the phone.
  if (questionsAsked >= 3) return null;

  return questions.find((q) => !q.required && !hasAnswer(collected, q.key)) ?? null;
}

/** True when every required field has an answer. */
export function isComplete(
  collected: CollectedAnswers,
  questions: readonly QuestionDefinition[] = DEFAULT_QUESTIONS,
): boolean {
  return questions.filter((q) => q.required).every((q) => hasAnswer(collected, q.key));
}

/** Required fields still outstanding — what the owner sees as gaps on the lead. */
export function missingRequired(
  collected: CollectedAnswers,
  questions: readonly QuestionDefinition[] = DEFAULT_QUESTIONS,
): FieldKey[] {
  return questions.filter((q) => q.required && !hasAnswer(collected, q.key)).map((q) => q.key);
}

/** The other field a prompt implicitly asks for, if any. */
export function pairedField(key: FieldKey): FieldKey | undefined {
  return PAIRED_WITH[key];
}

/**
 * Assert every prompt at module load.
 *
 * Same reasoning as `notifications/templates.ts`: a prompt that silently costs three
 * times as much must not be deployable, and an import cannot be skipped the way a
 * test can. These are shorter than the recovery message and carry no business name,
 * so one segment is ample — which makes a failure here a genuine mistake rather than
 * a tight fit.
 */
for (const question of DEFAULT_QUESTIONS) {
  assertSendable(question.prompt, `question prompt "${question.key}"`);
}
