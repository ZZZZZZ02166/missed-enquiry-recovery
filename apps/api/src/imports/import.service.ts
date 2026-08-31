import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import {
  assertCatalogueValid,
  assertKnowledgeValid,
  readKnowledge,
  validateKnowledgeEntry,
  validateServiceName,
  validateServicePricing,
  type CatalogueDraftEntry,
  type KnowledgeEntry,
} from 'shared-types';
import {
  LLM_PROVIDER,
  MAX_IMPORT_CHARS,
  type LlmProvider,
  type ProposedKnowledge,
  type ProposedService,
} from '../conversations/llm.provider';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ServicesService, toDraft, type ServiceInput } from '../services/services.service';

/**
 * Turning a document the owner already has into a catalogue they can use.
 *
 * Onboarding is the biggest adoption barrier in this product: nothing works until someone
 * hand-types a service list, and until they do, every caller gets the open-text question
 * and no price. Most of these businesses already have the list — in a price sheet, a
 * handbook, a quote template. This reads it once.
 *
 * **Three properties hold this together, and they are the whole safety story:**
 *
 * 1. **The document is never stored.** It arrives as a buffer, becomes text, becomes
 *    proposals, and is gone. There is no S3 bucket, no `documents` table, no cleanup job
 *    and no retention question to answer — an owner's handbook may contain their staff's
 *    names and their clients' addresses, and the cheapest way to protect it is to never
 *    hold it.
 *
 * 2. **Import saves nothing.** `propose` returns rows; `apply` takes rows back. Nothing
 *    is kept between them, so what gets written is exactly what the owner read and
 *    edited on the review screen — not a server-side draft that could have drifted from
 *    what they were shown. It also means no import state to expire or reconcile.
 *
 * 3. **An imported price cannot reach a caller by accident.** Every proposal comes back
 *    with `showPriceAutomatically: false`. A misread figure still reaches the owner's
 *    lead, where they see it, but it is never said to a customer until they tick the box.
 *    This is the rule that makes the whole feature safe to ship: the worst case of a
 *    misparse is a wrong number in front of the person who knows it is wrong.
 *
 * The model reads; it does not decide. Rule 2 is untouched — `PriceCalculator` still
 * computes every figure a customer hears, from the owner's stored config, after the
 * owner approved it.
 */

/** A proposed service, plus anything that stops it being saved as-is. */
export interface ServiceProposal extends ProposedService {
  /**
   * The review screen's default for "may customers hear this price". Always false.
   * See the class comment — this is property 3.
   */
  showPriceAutomatically: false;
  /**
   * Why this row cannot be saved yet, in the owner's words. Empty means it is fine.
   *
   * Validated here rather than only on apply so the owner sees "that name is too long"
   * beside the row while they are already editing it, instead of getting one rejection
   * for the whole batch after they press save.
   */
  problems: string[];
}

export interface KnowledgeProposal extends ProposedKnowledge {
  problems: string[];
}

export interface ImportProposal {
  services: ServiceProposal[];
  knowledge: KnowledgeProposal[];
  /** How much text came out of the document. Shown so a near-empty parse is visible. */
  characters: number;
}

/** What the owner approved, after editing. Saved as given. */
export interface ImportApplyInput {
  services: ServiceInput[];
  knowledge: Omit<KnowledgeEntry, 'id'>[];
}

export interface ImportApplyResult {
  servicesCreated: number;
  knowledgeSaved: number;
}

/**
 * Below this, the PDF had no usable text layer.
 *
 * A scanned page yields zero characters; a real price list yields hundreds. The gap is
 * wide enough that a fixed threshold is honest, and anything under it would not be worth
 * importing regardless of why it is short.
 */
const MIN_USEFUL_CHARS = 100;

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly prisma: PrismaService,
    private readonly services: ServicesService,
  ) {}

  /**
   * Pull the text layer out of a PDF, in memory.
   *
   * **A scanned PDF fails loudly.** It is the single most likely bad upload — an owner
   * photographs their price list, or their accountant sends a scan — and it is the one
   * failure that would otherwise be invisible: `getText` succeeds, returns nothing, the
   * model is asked to extract from an empty string and dutifully returns no services. The
   * owner sees "we found 0 services in your document" and concludes the feature is
   * broken. So an empty text layer is an error that names the cause and says what to do
   * instead.
   */
  async readPdf(data: Buffer): Promise<string> {
    // `pageJoiner: ''` suppresses the default "-- 1 of 3 --" page markers. They are noise
    // in the prompt and the model has no use for page numbers. The default cell separator
    // is left alone: a price list is usually a table, and the tab is what keeps a service
    // name attached to the figure in its row.
    const parser = new PDFParse({ data: new Uint8Array(data) });
    let text: string;
    let pages: number;
    try {
      const result = await parser.getText({ pageJoiner: '' });
      text = result.text;
      pages = result.total;
    } catch (error) {
      throw new BadRequestException(describePdfFailure(error));
    } finally {
      // pdfjs holds a worker and the decoded document until this runs. Without it, a few
      // imports of a large handbook keep all of them alive in the API process.
      await parser.destroy().catch(() => undefined);
    }

    if (text.replace(/\s+/g, '').length < MIN_USEFUL_CHARS) {
      throw new BadRequestException(
        `We could not read any text out of that PDF${pages > 0 ? ` (${pages} ${pages === 1 ? 'page' : 'pages'})` : ''}. ` +
          'It is most likely a scan or photos of pages rather than a document. ' +
          'Copy the text and paste it in instead.',
      );
    }

    this.logger.log(`Read ${text.length} characters from a ${pages}-page PDF`);
    return text;
  }

  /**
   * Read a document into proposals. **Writes nothing.**
   *
   * This is the only model call in the whole import path, and it is once per document
   * rather than once per conversation turn — which is the entire economic argument for
   * doing it this way. What comes back is a proposal the owner reviews.
   */
  async propose(text: string): Promise<ImportProposal> {
    const clean = this.assertImportable(text);
    const result = await this.llm.extractCatalogue({ text: clean });

    this.logger.log(
      `Import: ${result.services.length} services, ${result.knowledge.length} answers ` +
        `from ${clean.length} chars via ${result.model} ` +
        `(${result.usage.inputTokens} in, ${result.usage.outputTokens} out, ${result.latencyMs}ms)`,
    );
    // Dropped rows are logged rather than surfaced: the owner cannot act on "the model
    // returned a field we do not accept", but we need to see it if a document type
    // consistently loses rows.
    if (result.rejected.length > 0) {
      this.logger.warn(`Import dropped ${result.rejected.length} value(s): ${result.rejected.join('; ')}`);
    }

    return {
      services: result.services.map(toServiceProposal),
      knowledge: result.knowledge.map(toKnowledgeProposal),
      characters: clean.length,
    };
  }

  /**
   * Save what the owner approved.
   *
   * **The whole batch is validated against the existing catalogue before anything is
   * written.** `ServicesService.create` validates each row against the list as it will be
   * after that row — which is correct for a form, where rows arrive one at a time, but
   * here it would let five services be created and the sixth be refused for tipping the
   * catalogue over the active-service ceiling. The owner would then be looking at a
   * half-imported catalogue and an error, with no way to tell which rows landed.
   *
   * Pre-validating the full projection removes that case entirely: every catalogue rule
   * is monotone — fewer rows cannot break a rule that the whole set satisfies — so if the
   * projection is valid, no individual `create` below can fail on catalogue grounds.
   *
   * Services are written before knowledge, and both before anything is reported as done.
   * If the database fails partway the owner ends up with some of their services created,
   * visible and editable in the catalogue. That is not silent loss — it is the honest
   * failure mode, and the alternative (threading a transaction through `ServicesService`)
   * buys atomicity for a case where partial success is already recoverable by hand.
   */
  async apply(businessId: string, input: ImportApplyInput): Promise<ImportApplyResult> {
    const proposed = input.services ?? [];
    const approved = input.knowledge ?? [];

    if (proposed.length > 0) {
      const existing = await this.services.list(businessId);
      let sortOrder = existing.reduce((max, s) => Math.max(max, s.sortOrder), -1);
      const projected: CatalogueDraftEntry[] = [
        ...existing.map(toDraft),
        ...proposed.map(
          (service): CatalogueDraftEntry => ({
            name: service.name,
            availability: service.availability ?? 'ACTIVE',
            sortOrder: ++sortOrder,
            pricingType: service.pricingType,
            priceCents: service.priceCents,
            unitLabel: service.unitLabel,
            minUnits: service.minUnits,
            maxUnits: service.maxUnits,
          }),
        ),
      ];
      assertCatalogueValid(projected);
    }

    // Validated as a set, not row by row: the duplicate-question and total-count rules
    // only exist across entries, and a duplicate is worse than it looks — the matcher
    // sees a tie, refuses, and both answers stop working.
    const merged = mergeKnowledge(
      readKnowledge(await this.currentKnowledge(businessId)),
      approved,
    );
    assertKnowledgeValid(merged);

    let servicesCreated = 0;
    for (const service of proposed) {
      await this.services.create(businessId, {
        ...service,
        // Never trust the client for this one. It is the flag that decides whether an
        // imported figure can be said to a customer, so it is taken as an explicit true
        // and defaults to false for anything else the request might contain.
        showPriceAutomatically: service.showPriceAutomatically === true,
      });
      servicesCreated += 1;
    }

    if (approved.length > 0) {
      await this.prisma.db.business.update({
        where: { id: businessId },
        // Prisma types a JSON column as an index-signature shape, which an interface array
        // does not satisfy structurally even though it serialises identically. The cast is
        // the assertion that `KnowledgeEntry` is JSON-safe — which `readKnowledge` on the
        // way back out is what actually enforces.
        data: { knowledge: merged as unknown as Prisma.InputJsonValue },
      });
    }

    this.logger.log(
      `Import applied for business ${businessId}: ${servicesCreated} services, ` +
        `${approved.length} answers added (${merged.length} total)`,
    );
    return { servicesCreated, knowledgeSaved: approved.length };
  }

  /** The stored knowledge blob, scoped to the business. */
  private async currentKnowledge(businessId: string): Promise<unknown> {
    const business = await this.prisma.db.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { knowledge: true },
    });
    return business.knowledge;
  }

  /**
   * Refuse a document that is too long, rather than truncating it.
   *
   * A silently truncated import looks exactly like a document that simply had fewer
   * services in it — the owner approves eleven rows, never learns that pages nine to
   * eighty were dropped, and finds out when a caller asks about a service that is not in
   * the menu.
   */
  private assertImportable(text: string): string {
    const clean = text.trim();
    if (clean.length === 0) {
      throw new BadRequestException('There was no text to read.');
    }
    if (clean.length > MAX_IMPORT_CHARS) {
      throw new BadRequestException(
        `That document is ${Math.round(clean.length / 1000)}k characters and we read up to ` +
          `${MAX_IMPORT_CHARS / 1000}k at a time. Paste in just the pages with your services and prices.`,
      );
    }
    return clean;
  }
}

function toServiceProposal(service: ProposedService): ServiceProposal {
  return {
    ...service,
    showPriceAutomatically: false,
    problems: [...validateServiceName(service.name), ...validateServicePricing(service)].map((i) => i.message),
  };
}

function toKnowledgeProposal(entry: ProposedKnowledge): KnowledgeProposal {
  return { ...entry, problems: validateKnowledgeEntry(entry).map((i) => i.message) };
}

/**
 * Add newly approved answers to the ones already stored.
 *
 * **Appends rather than replaces.** An owner importing a second document — a policy sheet
 * after a price list — should not silently lose the first import's answers. Entries whose
 * question already exists are skipped, because a duplicate would break both copies rather
 * than shadowing one.
 */
function mergeKnowledge(
  existing: KnowledgeEntry[],
  additions: readonly Omit<KnowledgeEntry, 'id'>[],
): KnowledgeEntry[] {
  const key = (question: string): string => question.trim().toLowerCase().replace(/\s+/g, ' ');
  const seen = new Set(existing.map((entry) => key(entry.question)));
  const merged = [...existing];

  for (const addition of additions) {
    if (seen.has(key(addition.question))) continue;
    seen.add(key(addition.question));
    merged.push({ ...addition, id: randomUUID() });
  }
  return merged;
}

/**
 * Turn a pdfjs failure into something an owner can act on.
 *
 * Matched on `name` rather than by importing the exception classes: pdfjs throws these
 * from inside the worker, where `instanceof` across the module boundary is not reliable.
 */
function describePdfFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return 'That PDF is password-protected. Remove the password and upload it again, or paste the text in.';
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
    return 'That file is not a PDF we can open. If it came from a scanner or an email attachment, try pasting the text instead.';
  }
  return 'We could not read that PDF. Try pasting the text in instead.';
}
