import { normalise } from './service-matcher';

/**
 * Decides whether a caller's message is one of the questions the owner has already
 * answered — and refuses whenever it is not certain.
 *
 * This is what lets a common question be answered **without calling a model**: instantly,
 * for nothing, in the owner's own words. The model is not asked to write the reply and is
 * not asked to choose the entry; it is not involved at all. That keeps the property the
 * whole architecture rests on — every word a customer receives is either owner-authored
 * or produced by deterministic code — and it means an `LlmUnavailableError` no longer
 * takes the answer down with it.
 *
 * **The asymmetry that sets every threshold here.** Refusing to match costs one model
 * call, which is the path the product already takes today. Matching *wrongly* sends the
 * owner's answer about parking to someone asking about insurance. So this is tuned to
 * refuse: thresholds are higher than `matchService`'s, and a near-tie is never broken.
 *
 * **It is deliberately not the same scorer as `service-matcher`.** The mechanics are the
 * same shape and the tuning is not, because the two are reading different kinds of
 * English. A service catalogue is short noun phrases, where "price" and "job" carry no
 * signal; a knowledge base is questions, where "what is your minimum job" turns on
 * exactly those words and the empty ones are "do", "you", "what", "any". Sharing one
 * noise vocabulary would mean every tuning fix for one degraded the other. `normalise`
 * is shared, because that part genuinely is identical.
 */

export interface MatchableAnswer {
  id: string;
  question: string;
  aliases: string[];
}

export type KnowledgeMatchReason = 'matched' | 'no_match' | 'ambiguous' | 'no_knowledge';

export interface KnowledgeMatchResult {
  entryId: string | null;
  /** 0-100. Only meaningful when `reason` is `matched`. */
  confidence: number;
  reason: KnowledgeMatchReason;
  /** Entries that scored within the margin when the result is `ambiguous`. */
  tiedWith: string[];
}

/**
 * Higher than the service matcher's 55.
 *
 * There, a refusal loses the automatic quote that is the product's whole differentiator.
 * Here it loses nothing but the price of one model call — so the bar sits where a match
 * has to be obvious rather than merely plausible.
 */
const MIN_CONFIDENCE = 65;

/** A runner-up this close means the caller's words did not choose between them. */
const AMBIGUITY_MARGIN = 10;

/**
 * How much of what the caller actually said the matched question must account for.
 *
 * **This is the second line of defence for the mixed message, and the more robust one.**
 * "2 bed 2 bath, and do you bring supplies?" leaves `bed`, `bath` and two numbers
 * unexplained by any question about supplies, so the coverage test fails and the message
 * goes to extraction where those fields are collected. `ConversationsService` also checks
 * that no required field is outstanding before it will use a match — but that check can
 * only see fields it already knows to want, and this one sees any unexplained content at
 * all. Losing a field to save a model call is the worst trade available here.
 */
const MIN_TEXT_COVERAGE = 0.6;

/**
 * Words that carry no signal about *which question* is being asked.
 *
 * Question scaffolding, mostly. Note what is deliberately **absent** and is present in
 * `service-matcher`'s list: "price", "quote", "job" and "service" are empty words when
 * choosing between service names and load-bearing ones in a knowledge base, where "what
 * is your minimum job" and "do you price on site" are entries that turn on exactly those
 * words.
 */
const NOISE = new Set([
  'a', 'an', 'the', 'i', 'my', 'me', 'we', 'us', 'our', 'you', 'your', 'yours', 'it', 'its',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'done', 'doing',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'have', 'has', 'had',
  'what', 'whats', 'how', 'when', 'where', 'which', 'who', 'why', 'if', 'or', 'and', 'but',
  'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'as', 'that', 'this', 'these',
  'there', 'then', 'than', 'so', 'any', 'some', 'all', 'also', 'just', 'please', 'thanks',
  'thank', 'hi', 'hello', 'hey', 'yes', 'no', 'ok', 'okay', 'need', 'want', 'get', 'got',
  'know', 'tell', 'about', 'like', 'much', 'many', 'you re', 'guys',
  // Indefinite placeholders. They stand in for the thing being asked about and are never
  // the thing itself, so they can never identify *which* question is meant — but left in
  // they count as unexplained content and sink the coverage test. Found by matching a real
  // imported knowledge base against real phrasings: "do I need to provide anything?" was
  // refused against an entry whose vocabulary already contained "provide".
  'anything', 'something', 'anywhere', 'somewhere',
]);

/**
 * Find the stored answer a message is asking for.
 *
 * `text` is the caller's raw reply. Unlike `matchService` there is no second candidate to
 * try: the model's reading is not available here and is not wanted — the entire point is
 * to decide before spending a model call.
 */
export function matchKnowledge(
  entries: readonly MatchableAnswer[],
  text: string | null | undefined,
): KnowledgeMatchResult {
  if (entries.length === 0) {
    return { entryId: null, confidence: 0, reason: 'no_knowledge', tiedWith: [] };
  }

  const message = normalise(text ?? '');
  if (message.length === 0) {
    return { entryId: null, confidence: 0, reason: 'no_match', tiedWith: [] };
  }

  // Computed across this business's own knowledge base, not hard-coded: "supplies" is
  // decisive when one entry mentions it and meaningless when six do.
  const distinctive = distinctiveTokens(entries);
  const asked = new Set(contentTokens(message));

  const scored = entries
    .map((entry) => ({
      id: entry.id,
      score: admissible(entry, asked, distinctive)
        ? Math.max(
            ...[entry.question, ...entry.aliases].map((phrase) =>
              scorePhrase(normalise(phrase), message, distinctive),
            ),
          )
        : 0,
    }))
    .filter((s) => s.score >= MIN_CONFIDENCE)
    .sort((a, b) => b.score - a.score);

  const [winner, ...rest] = scored;
  if (!winner) return { entryId: null, confidence: 0, reason: 'no_match', tiedWith: [] };

  const contenders = rest.filter((s) => winner.score - s.score <= AMBIGUITY_MARGIN);
  if (contenders.length > 0) {
    // Never broken by picking the highest. Two entries this close means the message did
    // not distinguish them, and sending one of them confidently is the failure this
    // whole module is arranged to avoid.
    return {
      entryId: null,
      confidence: winner.score,
      reason: 'ambiguous',
      tiedWith: [winner.id, ...contenders.map((c) => c.id)],
    };
  }

  return { entryId: winner.id, confidence: winner.score, reason: 'matched', tiedWith: [] };
}

/**
 * May this entry be considered for this message at all?
 *
 * Two gates, and they catch different things — **neither is redundant**, which the probe
 * that produced them made plain:
 *
 * 1. **A word belonging distinctively to a *different* entry means the caller asked about
 *    that too.** "Are you insured and do you bring supplies?" is a compound question, and
 *    answering half of it is worse than answering none: the caller reads a confident
 *    reply and assumes both halves were addressed. Coverage alone let this through at
 *    0.67, and would have kept letting it through at any threshold that still admitted
 *    ordinary phrasing.
 *
 * 2. **Most of what the caller said must be vocabulary this entry knows.** This is what
 *    keeps "2 bed 2 bath in Southbank, and do you bring supplies?" out — "bed", "bath"
 *    and "southbank" appear in no entry at all, so gate 1 cannot see them, and losing
 *    those fields to save a model call is the worst trade available here.
 *
 * Coverage is measured against the entry's **whole vocabulary**, question and aliases
 * together, not against whichever phrase is being scored. Measuring it per phrase was the
 * first version and it inverted the ranking: "do you work saturday" was refused while the
 * vaguer "saturday" matched, because "work" and "saturday" live in different aliases of
 * the same entry and neither phrase could account for both.
 */
function admissible(
  entry: MatchableAnswer,
  asked: ReadonlySet<string>,
  distinctive: ReadonlySet<string>,
): boolean {
  if (asked.size === 0) return false;

  const vocabulary = new Set(
    [entry.question, ...entry.aliases].flatMap((phrase) => contentTokens(normalise(phrase))),
  );

  for (const token of asked) {
    if (distinctive.has(token) && !vocabulary.has(token)) return false;
  }

  const explained = [...asked].filter((token) => vocabulary.has(token)).length;
  return explained / asked.size >= MIN_TEXT_COVERAGE;
}

/**
 * How well one stored question matches what the caller wrote.
 *
 * Every tier below an exact match requires a **distinctive** shared word. That is
 * stricter than `matchService`, which allows containment alone to carry a match, and the
 * reason is the size of the haystack: six service names cannot collide much, forty
 * questions phrased in ordinary English collide constantly.
 *
 * Coverage is not checked here — `admissible` has already done it against the entry's
 * whole vocabulary, which is the only place it can be judged correctly.
 */
function scorePhrase(phrase: string, text: string, distinctive: ReadonlySet<string>): number {
  if (phrase.length === 0) return 0;
  if (phrase === text) return 100;

  const phraseTokens = contentTokens(phrase);
  const textTokens = new Set(contentTokens(text));
  if (phraseTokens.length === 0 || textTokens.size === 0) return 0;

  const shared = phraseTokens.filter((t) => textTokens.has(t));
  if (shared.length === 0) return 0;

  // A match assembled only from words every entry uses is not a match.
  const distinctiveShared = shared.filter((t) => distinctive.has(t));
  if (distinctiveShared.length === 0) return 0;

  // The caller wrote the question out, in among other words: "hi, do you bring your own
  // supplies?" against the entry's own phrasing. The strongest evidence short of an
  // exact match, and it still had to clear distinctiveness and coverage to get here.
  if (containsPhrase(text, phrase)) return Math.min(97, 75 + phraseTokens.length * 6);

  const base = 60 + distinctiveShared.length * 12;
  // A small nudge for explaining more of the stored question, so a two-word overlap
  // outranks a one-word overlap against the same entry.
  const coverageBonus = Math.round((shared.length / phraseTokens.length) * 10);
  return Math.min(95, base + coverageBonus);
}

/** Tokens that belong to exactly one entry's vocabulary. */
function distinctiveTokens(entries: readonly MatchableAnswer[]): ReadonlySet<string> {
  const owners = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const phrase of [entry.question, ...entry.aliases]) {
      for (const token of contentTokens(normalise(phrase))) {
        const set = owners.get(token) ?? new Set<string>();
        set.add(entry.id);
        owners.set(token, set);
      }
    }
  }
  return new Set([...owners.entries()].filter(([, ids]) => ids.size === 1).map(([token]) => token));
}

function contentTokens(value: string): string[] {
  return value.split(' ').filter((t) => t.length > 0 && !NOISE.has(t));
}

/** Word-boundary containment, so "bath" does not match inside "bathroom". */
function containsPhrase(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}
