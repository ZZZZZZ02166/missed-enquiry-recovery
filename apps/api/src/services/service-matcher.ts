import type { ServiceAvailability } from '../generated/prisma/client';

/**
 * Matches what a caller said to something the business actually sells.
 *
 * The step between extraction and pricing. The model returns free text — "bond
 * clean", "end of lease", "just a general tidy up" — and this decides which
 * catalogue entry that is, or refuses to decide.
 *
 * **Refusing is a first-class outcome.** No match falls through to a manual quote,
 * which is a lead the owner rings back. A *wrong* match quotes the wrong price for
 * the wrong job, which is worse than any amount of silence: it is a number the owner
 * has to withdraw in front of the customer (`docs/decisions.md`, Part 6 — "never
 * guess").
 *
 * Pure and self-contained so the ambiguity rules can be tested exhaustively. This is
 * the one piece of fuzzy logic in a system that is otherwise deterministic, so it
 * gets the most adversarial test suite.
 */

export interface MatchableService {
  id: string;
  name: string;
  aliases: string[];
  availability: ServiceAvailability;
}

export type MatchReason = 'matched' | 'no_match' | 'ambiguous' | 'empty_catalogue';

export interface MatchResult {
  serviceId: string | null;
  /** 0-100. Only meaningful when `reason` is `matched`. */
  confidence: number;
  reason: MatchReason;
  /** Ids that scored equally when the result is `ambiguous` — the owner sees these. */
  tiedWith: string[];
}

/**
 * Below this, a match is a coincidence rather than a reading.
 *
 * Tuned against the failure that matters: "I need a clean" scoring 40 against every
 * cleaning service in the catalogue and picking whichever sorted first.
 */
const MIN_CONFIDENCE = 55;

/**
 * How close a runner-up may be before the result is ambiguous rather than a winner.
 *
 * Generous on purpose. Two services within ten points of each other means the caller's
 * words genuinely did not distinguish them, and asking is cheap next to quoting the
 * wrong one.
 */
const AMBIGUITY_MARGIN = 10;

/**
 * How much of what the caller *said* the shared words must account for.
 *
 * The other half of distinctiveness, and it exists because distinctiveness alone is
 * meaningless in a one-service catalogue — every token is trivially unique, so "bond
 * clean" matched `Regular home clean` on the word "clean". Requiring the overlap to
 * cover most of the caller's own content words kills that: "bond" is left unexplained,
 * which is precisely the evidence that they meant something else.
 */
const MIN_TEXT_COVERAGE = 0.6;

/** Words that carry no signal about *which* service is meant. */
const NOISE = new Set([
  'a', 'an', 'the', 'i', 'need', 'want', 'get', 'some', 'please', 'looking', 'for',
  'my', 'our', 'we', 'you', 'do', 'does', 'can', 'would', 'like', 'to', 'of', 'and',
  'is', 'it', 'in', 'on', 'at', 'with', 'have', 'has', 'am', 'are', 'quote', 'price',
  'job', 'service', 'services', 'help',
  // Filler that survives normalisation and would otherwise count as an unexplained
  // word, sinking the coverage test for a perfectly clear request ("windows need
  // doing"). Only words that cannot name a service go here.
  'doing', 'done', 'hi', 'hello', 'thanks', 'just', 'also', 'me', 'us', 'about',
  'after', 'there', 'was', 'were', 'be', 'been', 'sorted', 'organised',
]);

/**
 * Find the service a caller means.
 *
 * `serviceType` is the model's own read and is tried first — it has the whole
 * conversation in view. The raw reply is the fallback, because the model can return a
 * paraphrase ("bond clean") when the catalogue calls it something else.
 */
export function matchService(
  catalogue: readonly MatchableService[],
  input: { serviceType?: string | null; text?: string | null },
): MatchResult {
  // Only what the business currently sells. A disabled or temporarily unavailable
  // service must never be matched, or the caller is quoted for work that cannot be
  // done — the same reason `PriceCalculator` refuses them.
  const active = catalogue.filter((s) => s.availability === 'ACTIVE');
  if (active.length === 0) {
    return { serviceId: null, confidence: 0, reason: 'empty_catalogue', tiedWith: [] };
  }

  // Tokens that appear in more than one service's vocabulary carry no distinguishing
  // signal *for this business*. "Clean" is meaningless in a catalogue of five cleaning
  // services and decisive in one that also does gardening — so it is computed from the
  // catalogue rather than hard-coded.
  const distinctive = distinctiveTokens(active);

  const best = [input.serviceType, input.text]
    .map((candidate) => scoreAll(active, candidate, distinctive))
    .find((scores) => scores.length > 0 && scores[0]!.score >= MIN_CONFIDENCE);

  if (!best) return { serviceId: null, confidence: 0, reason: 'no_match', tiedWith: [] };

  const [winner, ...rest] = best;
  const contenders = rest.filter((s) => winner!.score - s.score <= AMBIGUITY_MARGIN);

  if (contenders.length > 0) {
    // Deliberately not "pick the highest". The caller's words did not distinguish
    // these, so the conversation should ask rather than the system decide.
    return {
      serviceId: null,
      confidence: winner!.score,
      reason: 'ambiguous',
      tiedWith: [winner!.id, ...contenders.map((c) => c.id)],
    };
  }

  return { serviceId: winner!.id, confidence: winner!.score, reason: 'matched', tiedWith: [] };
}

interface Scored {
  id: string;
  score: number;
}

function scoreAll(
  services: readonly MatchableService[],
  candidate: string | null | undefined,
  distinctive: Set<string>,
): Scored[] {
  const text = normalise(candidate ?? '');
  if (text.length === 0) return [];

  return services
    .map((service) => ({
      id: service.id,
      score: Math.max(
        ...[service.name, ...service.aliases].map((phrase) =>
          scorePhrase(normalise(phrase), text, distinctive),
        ),
      ),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * How well one catalogue phrase matches what the caller said.
 *
 * Three tiers, in descending confidence: the same thing, one contains the other, or
 * they share distinctive words.
 */
function scorePhrase(phrase: string, text: string, distinctive: Set<string>): number {
  if (phrase.length === 0) return 0;
  if (phrase === text) return 100;

  // "I need an end of lease clean please" contains "end of lease clean". Longer
  // phrases score higher: matching four words is far stronger evidence than one, and
  // this is what stops a short generic entry beating a specific one.
  if (containsPhrase(text, phrase)) return Math.min(95, 70 + tokens(phrase).length * 6);
  if (containsPhrase(phrase, text)) return Math.min(90, 65 + tokens(text).length * 6);

  const phraseTokens = tokens(phrase).filter((t) => !NOISE.has(t));
  const textTokens = new Set(tokens(text).filter((t) => !NOISE.has(t)));
  if (phraseTokens.length === 0 || textTokens.size === 0) return 0;

  const shared = phraseTokens.filter((t) => textTokens.has(t));
  if (shared.length === 0) return 0;

  // The rule that stops "I need a clean" picking one of five cleaning services: a
  // match built only from words every service shares is not a match at all.
  const distinctiveShared = shared.filter((t) => distinctive.has(t));
  if (distinctiveShared.length === 0) return 0;

  // ...and the second half: the overlap has to explain most of what the caller said.
  // A word of theirs left unaccounted for is evidence they meant something this
  // catalogue does not contain — "bond" in "bond clean" against `Regular home clean`.
  if (shared.length / textTokens.size < MIN_TEXT_COVERAGE) return 0;

  // Scored on **distinctiveness, not coverage of the catalogue name**. Coverage of the
  // name was the first attempt and it was wrong in the most common case there is: "can
  // you do my oven" shares one token with `Oven cleaning`, which is 50% and scored
  // below the threshold — so the clearest possible request matched nothing. What
  // carries the signal is that "oven" identifies exactly one service; how long the
  // catalogue name it came from happens to be is irrelevant to the caller.
  //
  // Name coverage survives as a small bonus, so "carpet steam" still outranks "carpet"
  // against `Carpet steam cleaning`.
  const base = 55 + distinctiveShared.length * 10;
  const coverageBonus = Math.round((shared.length / phraseTokens.length) * 10);
  return Math.min(90, base + coverageBonus);
}

/** Tokens unique to exactly one service's vocabulary across the catalogue. */
function distinctiveTokens(services: readonly MatchableService[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const service of services) {
    for (const phrase of [service.name, ...service.aliases]) {
      for (const token of tokens(normalise(phrase))) {
        if (NOISE.has(token)) continue;
        const set = owners.get(token) ?? new Set<string>();
        set.add(service.id);
        owners.set(token, set);
      }
    }
  }
  return new Set([...owners.entries()].filter(([, ids]) => ids.size === 1).map(([token]) => token));
}

/** Word-boundary containment, so "bath" does not match inside "bathroom". */
function containsPhrase(haystack: string, needle: string): boolean {
  const h = ` ${haystack} `;
  const n = ` ${needle} `;
  return h.includes(n);
}

/**
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * Also drops a trailing plural `s` per token, so "carpets" matches "carpet". Blunt,
 * and deliberately so: a stemmer would fold "cleaning" and "cleaner" together, which
 * for a business that sells both a clean and a cleaner is exactly the distinction that
 * must survive.
 */
export function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .join(' ');
}

function tokens(value: string): string[] {
  return value.split(' ').filter((t) => t.length > 0);
}
