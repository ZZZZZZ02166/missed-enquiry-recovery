import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationsService } from '../conversations/conversations.service';
import { FakeLlmProvider } from '../conversations/llm.provider';
import type { PricedCatalogueEntry } from '../conversations/conversations.service';

/**
 * CLAUDE.md rule 2, as something that fails a build.
 *
 * "The model never prices" and "every currency figure comes from `PriceCalculator`" have
 * been true by construction for several steps — the extraction schema has no currency
 * field, and `quoteMessage` takes a `PriceResult` rather than a number. Both of those are
 * good designs and neither is a *check*. A future template with `"$50 off"` typed into
 * it, or a helper that formats cents somewhere new, would pass every existing test.
 *
 * Two guards, deliberately different in kind:
 *
 *  1. **Static.** No source file outside the two pricing modules may contain a currency
 *     figure at all. Cheap, total, and catches the case nobody thought to test.
 *  2. **Behavioural.** A caller who explicitly asks for a discount gets no number back.
 *     This is the adversarial case from the plan's verification list, and it exercises
 *     the whole conversation rather than a string.
 */

/** The only modules allowed to render money, and why. */
const CURRENCY_ALLOWLIST = new Set([
  // Owns `formatCents` — the one function that turns integer cents into "$280".
  'services/price-calculator.ts',
  // The only module that composes a customer-facing sentence containing a figure, and
  // it can only obtain one from a `PriceResult`.
  'services/quote-message.ts',
]);

const SRC = join(__dirname, '..');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // `generated` is Prisma's output and not ours to police.
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Strip comments before scanning.
 *
 * A comment explaining "$280 ex-GST becomes $308" is documentation, not a price anyone
 * can be told. Flagging it would make the guard so noisy it would be disabled, which is
 * the usual way a rule like this dies.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('rule 2 — no currency figure escapes PriceCalculator', () => {
  it('no module outside the pricing modules contains a currency figure', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1);
      if (CURRENCY_ALLOWLIST.has(relative)) continue;

      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        // `$` followed by a digit is a price. `${...}` interpolation is not, and neither
        // is a lone `$` in a regex or a shell string.
        if (/\$\s?\d/.test(line)) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('formatCents is only called from the modules allowed to render money', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1);
      if (CURRENCY_ALLOWLIST.has(relative)) continue;
      if (/\bformatCents\b/.test(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The adversarial case from the plan: a caller who names a number and asks us to beat
   * it. The model is handed that sentence and is free to return whatever it likes; the
   * extraction schema has nowhere to put a price, and nothing downstream will render one.
   */
  it('a caller asking for a discount is never quoted a counter-offer', async () => {
    const llm = new FakeLlmProvider();
    // Whatever the model returns, including a price it invented.
    llm.respondWith({
      serviceType: 'End of lease clean',
      suburb: 'Southbank',
      bedrooms: 2,
      bathrooms: 1,
      preferredDate: 'Tuesday',
      price: 15000,
      quotedPrice: '$150',
      discount: '20%',
    } as never);

    const catalogue: PricedCatalogueEntry[] = [
      {
        id: 'eol', name: 'End-of-lease cleaning', availability: 'ACTIVE', sortOrder: 0,
        pricingType: 'FIXED', priceCents: 28000, unitLabel: null, minUnits: null, maxUnits: null,
        showPriceAutomatically: true, priceConfidence: 'FIRM', requiresConfirmation: false,
        requiredFields: [],
      },
    ];

    const decision = await new ConversationsService(llm).advance({
      businessName: 'Melbourne Sparkle',
      inboundText: 'my last cleaner charged $200, can you beat it?',
      catalogue,
      pricesIncludeGst: true,
      conversation: {
        state: 'COLLECTING',
        collected: {},
        awaitingField: 'preferredDate',
        questionsAsked: 3,
        needsHuman: false,
        needsHumanReason: null,
        pendingChoice: null,
        selectedServiceId: 'eol',
      },
    });

    // The configured price may legitimately appear — that is the whole product. What may
    // never appear is the caller's number, or anything derived from it.
    expect(decision.reply.body).not.toContain('200');
    expect(decision.reply.body).not.toContain('150');
    expect(decision.reply.body).not.toMatch(/discount|off\b|beat|deal|match/i);

    // Every figure in the message traces to the calculator.
    const figures = [...decision.reply.body.matchAll(/\$[\d,]+(?:\.\d\d)?/g)].map((m) => m[0]);
    for (const figure of figures) {
      expect(figure).toBe('$280');
    }

    // And the extraction never smuggled a price into the answers.
    expect(JSON.stringify(decision.collected)).not.toContain('150');
    expect(JSON.stringify(decision.collected)).not.toContain('200');
  });
});
