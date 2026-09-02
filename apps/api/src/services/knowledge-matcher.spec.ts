import { matchKnowledge, type MatchableAnswer } from './knowledge-matcher';

/**
 * The adversarial suite for the one piece of fuzzy logic in the deterministic path.
 *
 * Everything here is written against the same asymmetry the module is tuned for: a
 * refusal costs one model call, a wrong match sends the owner's answer about insurance to
 * someone asking about parking. So roughly half of these tests assert that nothing
 * matched, and each of those names the wrong answer it is preventing.
 */

const entry = (id: string, question: string, aliases: string[] = []): MatchableAnswer => ({
  id, question, aliases,
});

/** A knowledge base shaped like one a Melbourne end-of-lease cleaner would actually have. */
const BASE: MatchableAnswer[] = [
  entry('supplies', 'Do you bring your own supplies?', [
    'do you bring products',
    'do I need to provide anything',
  ]),
  entry('insured', 'Are you insured?', ['do you have insurance', 'are you police checked']),
  entry('notice', 'How much notice do you need?', ['how far ahead should I book']),
  entry('weekends', 'Do you work weekends?', ['are you open Saturday']),
  entry('areas', 'What areas do you cover?', ['do you come to my suburb']),
  entry('bond', 'Do you guarantee the bond back?', ['is there a bond back guarantee']),
];

describe('matchKnowledge', () => {
  describe('matches the owner would expect', () => {
    it('matches the stored question word for word', () => {
      const result = matchKnowledge(BASE, 'Do you bring your own supplies?');
      expect(result).toMatchObject({ entryId: 'supplies', reason: 'matched' });
      expect(result.confidence).toBe(100);
    });

    it('matches an alias', () => {
      expect(matchKnowledge(BASE, 'do you have insurance')).toMatchObject({
        entryId: 'insured',
        reason: 'matched',
      });
    });

    it('ignores greetings and politeness around the question', () => {
      expect(matchKnowledge(BASE, 'hi, do you bring your own supplies? thanks')).toMatchObject({
        entryId: 'supplies',
        reason: 'matched',
      });
    });

    it('matches a shortened version of the question', () => {
      expect(matchKnowledge(BASE, 'how much notice?')).toMatchObject({
        entryId: 'notice',
        reason: 'matched',
      });
    });

    it('does not rank a vaguer message above a more specific one', () => {
      // Both name the same entry, and the more specific message must not do worse. The
      // first version measured coverage per phrase and refused "do you work saturday"
      // while matching a bare "saturday" — "work" and "saturday" live in different
      // aliases of the same entry, so no single phrase could account for both.
      expect(matchKnowledge(BASE, 'do you work saturday').entryId).toBe('weekends');
      expect(matchKnowledge(BASE, 'saturday').entryId).toBe('weekends');
    });

    it('matches a question phrased with none of the stored wording but the same content', () => {
      expect(matchKnowledge(BASE, 'what suburbs do you cover?')).toMatchObject({
        entryId: 'areas',
        reason: 'matched',
      });
    });

    it('matches when the caller uses an indefinite placeholder', () => {
      // Found by matching a live imported knowledge base against real phrasings, not by
      // design: "anything" is a placeholder for the thing being asked about and never the
      // thing itself, so counting it as unexplained content refused a question the entry
      // clearly covered.
      expect(matchKnowledge(BASE, 'do I need to provide anything?')).toMatchObject({
        entryId: 'supplies',
        reason: 'matched',
      });
    });

    it('is not thrown by casing, punctuation or a plural', () => {
      expect(matchKnowledge(BASE, 'DO YOU BRING PRODUCTS!!!')).toMatchObject({
        entryId: 'supplies',
        reason: 'matched',
      });
    });
  });

  describe('refusals — each one is a wrong answer not sent', () => {
    it('refuses when there is no knowledge at all', () => {
      expect(matchKnowledge([], 'do you bring supplies')).toMatchObject({
        entryId: null,
        reason: 'no_knowledge',
      });
    });

    it('refuses an empty or whitespace message', () => {
      expect(matchKnowledge(BASE, '   ')).toMatchObject({ entryId: null, reason: 'no_match' });
      expect(matchKnowledge(BASE, null)).toMatchObject({ entryId: null, reason: 'no_match' });
    });

    it('refuses a greeting that asks nothing', () => {
      for (const message of ['hi', 'hello there', 'thanks!', 'ok', 'yes please']) {
        expect(matchKnowledge(BASE, message).entryId).toBeNull();
      }
    });

    /**
     * The compounding failure this module exists to avoid: answering the question,
     * skipping extraction, and losing the two fields the owner needed.
     */
    it('refuses a message that asks a known question AND carries other information', () => {
      const result = matchKnowledge(BASE, '2 bed 2 bath in Southbank, and do you bring supplies?');
      expect(result.entryId).toBeNull();
      expect(result.reason).toBe('no_match');
    });

    it('refuses a question about something the owner never answered', () => {
      for (const message of [
        'do you do gardening',
        'can you remove rubbish',
        'do you clean solar panels',
      ]) {
        expect(matchKnowledge(BASE, message).entryId).toBeNull();
      }
    });

    it('refuses a plain service request', () => {
      // This is a job enquiry, not a question. Answering it from the knowledge base
      // instead of extracting a lead would be the most expensive possible mistake.
      for (const message of [
        'I need an end of lease clean',
        'can you quote me for a 3 bedroom house',
        'looking for a cleaner next Tuesday',
      ]) {
        expect(matchKnowledge(BASE, message).entryId).toBeNull();
      }
    });

    it('refuses a single word every entry shares', () => {
      // "you" and "do" are scaffolding; nothing here identifies which question is meant.
      expect(matchKnowledge(BASE, 'do you?').entryId).toBeNull();
    });

    it('refuses a word that belongs to more than one entry', () => {
      const overlapping = [
        entry('a', 'Do you work weekends?'),
        entry('b', 'Do you charge extra on weekends?'),
      ];
      // "weekend" no longer identifies either one, so neither may be sent.
      expect(matchKnowledge(overlapping, 'weekends?').entryId).toBeNull();
    });
  });

  describe('ambiguity is never broken by picking the highest', () => {
    /**
     * The reachable route to a tie, and a real one: `validateKnowledge` forbids two
     * entries sharing a *question*, but nothing stops one entry's alias colliding with
     * another entry's question. The owner then has the same words filed in two places and
     * must not have one of them answered confidently.
     */
    it('refuses when two entries are phrased the same way', () => {
      const overlapping = [
        entry('weekends', 'Do you work weekends?', ['are you open on the weekend']),
        entry('hours', 'Are you open on the weekend?'),
      ];
      const result = matchKnowledge(overlapping, 'are you open on the weekend?');
      expect(result.entryId).toBeNull();
      expect(result.reason).toBe('ambiguous');
      expect([...result.tiedWith].sort()).toEqual(['hours', 'weekends']);
    });

    /**
     * A compound question is refused *harder* than an ambiguous one — it does not reach
     * scoring at all. Answering half of what someone asked is worse than answering none,
     * because they read a confident reply and assume both halves were addressed.
     */
    it('refuses a compound question before it can score', () => {
      const similar = [
        entry('clean', 'Do you do end of lease cleaning?'),
        entry('inspect', 'Do you do end of lease inspections?'),
      ];
      const result = matchKnowledge(similar, 'end of lease cleaning and inspection');
      expect(result.entryId).toBeNull();
      expect(result.reason).toBe('no_match');
    });

    it('refuses to answer one half of a compound question about two known things', () => {
      // Found by probing, not by design: coverage alone admitted this at 0.67 and it
      // answered only the supplies half, with full confidence.
      const result = matchKnowledge(BASE, 'are you insured and do you bring supplies?');
      expect(result.entryId).toBeNull();
    });

    it('still picks a clear winner when one entry is genuinely closer', () => {
      const similar = [
        entry('clean', 'Do you do end of lease cleaning?'),
        entry('inspect', 'Do you do end of lease inspections?'),
      ];
      expect(matchKnowledge(similar, 'do you do end of lease cleaning?')).toMatchObject({
        entryId: 'clean',
        reason: 'matched',
      });
    });
  });

  describe('properties that must hold across the whole base', () => {
    it('never returns an entry id unless the reason is matched', () => {
      const messages = [
        '', 'hi', 'do you?', 'weekends', '2 bed 2 bath and do you bring supplies',
        'I need an end of lease clean', 'do you do gardening', 'what',
        'do you bring your own supplies', 'are you insured', 'how much notice',
      ];
      for (const message of messages) {
        const result = matchKnowledge(BASE, message);
        if (result.reason !== 'matched') expect(result.entryId).toBeNull();
        else expect(result.entryId).not.toBeNull();
      }
    });

    it('never matches below the confidence floor', () => {
      const messages = ['do you bring your own supplies', 'are you insured', 'how much notice'];
      for (const message of messages) {
        const result = matchKnowledge(BASE, message);
        if (result.reason === 'matched') expect(result.confidence).toBeGreaterThanOrEqual(65);
      }
    });

    it('is stable — the same message always gives the same answer', () => {
      const first = matchKnowledge(BASE, 'do you bring products');
      for (let i = 0; i < 5; i += 1) {
        expect(matchKnowledge(BASE, 'do you bring products')).toEqual(first);
      }
    });

    it('does not depend on the order entries are stored in', () => {
      const forwards = matchKnowledge(BASE, 'are you police checked');
      const backwards = matchKnowledge([...BASE].reverse(), 'are you police checked');
      expect(backwards).toEqual(forwards);
      expect(forwards.entryId).toBe('insured');
    });
  });
});
