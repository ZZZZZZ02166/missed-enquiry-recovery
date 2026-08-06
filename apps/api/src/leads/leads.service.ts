import { Injectable, Logger } from '@nestjs/common';
import type { CollectedAnswers, FieldKey } from '../conversations/question-flow';
import { Prisma, type Lead } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { PriceResult } from '../services/price-calculator';
import { hasAnyAnswer, nextLeadStatus, toLeadColumns } from './lead-mapping';

/**
 * Leads — the structured record the owner acts on.
 *
 * **A call is not a lead** (`docs/decisions.md`). Leads are created lazily, on the
 * customer's first reply, and calls that never get a response stay as calls. That is
 * what keeps the owner's inbox honest and makes "% of missed callers who became
 * qualified leads" a number that means something rather than a restatement of call
 * volume.
 *
 * Kept apart from `ConversationsService` on purpose. The conversation is the
 * transcript and the cursor — it changes shape every time the question flow changes.
 * The lead is what the owner sees, and it should not.
 */

export interface LeadSyncInput {
  businessId: string;
  customerId: string;
  conversationId: string;
  /** Everything the conversation has collected so far. */
  collected: CollectedAnswers;
  /** True once every required field is answered. */
  conversationComplete: boolean;
  needsHuman: boolean;
  needsHumanReason: string | null;
  /** Required fields still outstanding — the owner's "what do I still need to ask?" */
  stillMissing: FieldKey[];
  optedOut?: boolean;
  /**
   * Urgency read from the latest reply, if it mentioned timing at all.
   *
   * Undefined means this reply was silent on it — which is not the same as "not
   * urgent", so an undefined value leaves any previously detected urgency alone
   * rather than clearing it.
   */
  urgency?: 'low' | 'normal' | 'high';
  /** The catalogue service the customer chose, or null for a manual-quote enquiry. */
  selectedServiceId?: string | null;
  /**
   * The price computed on this turn, if any.
   *
   * Recorded on the lead the first time a figure exists and never rewritten — see
   * `quoteColumns`.
   */
  quote?: PriceResult | null;
}

/**
 * The quote columns to write, or nothing.
 *
 * Written **once**, the first time a real figure exists, and never rewritten. The lead is
 * the record of what the customer was told; if the owner raises prices next month, or the
 * conversation carries on and the calculator produces a different number, the recorded
 * quote must not follow. `quoteSnapshot` freezes the config alongside it for the same
 * reason.
 *
 * `quotedAt` is a **record, not a gate.** Nothing may use it to decide whether to send —
 * it is written before the reply goes out, and a marker written before the side effect it
 * marks is the exact shape rule 13 forbids. It is safe today only because the send is
 * driven by the reserved `messages` row, so a retry re-sends from there regardless of
 * what this column says. The moment something reads `quotedAt` to decide whether to
 * quote, that read has to happen before the message is composed, and this write has to
 * move after the send.
 */
function quoteColumns(
  quote: PriceResult | null | undefined,
  alreadyQuotedAt: Date | null,
): Record<string, unknown> {
  if (alreadyQuotedAt !== null) return {};
  if (!quote || quote.amountCents === null) return {};

  return {
    quotedAmountCents: quote.amountCents,
    quoteType: quote.quoteType,
    // Whether the caller was actually told. False with a non-null amount is a real,
    // meaningful state: the owner wanted the figure on the lead without it being
    // promised on their behalf.
    quoteShownToCustomer: quote.showToCustomer,
    quotedAt: new Date(),
    quoteSnapshot: quote.snapshot as unknown as Prisma.InputJsonObject,
  };
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or update the lead for a conversation.
   *
   * Called on **every** advance, not only the first. A lead that is written once and
   * never updated shows the owner whatever was known thirty seconds into the
   * conversation, which is usually a suburb and nothing else — worse than no lead,
   * because it looks complete.
   *
   * Idempotent by the unique `conversationId`, so a replayed job converges rather
   * than duplicating.
   */
  async syncFromConversation(input: LeadSyncInput): Promise<Lead> {
    const { businessId, conversationId } = input;

    // Read first, because the status decision depends on what is already there — an
    // owner-set outcome must not be overwritten. `findFirst` rather than `findUnique`:
    // a unique lookup cannot carry a tenant constraint (tenant-guard).
    const existing = await this.prisma.db.lead.findFirst({
      where: { businessId, conversationId },
      select: { id: true, status: true, quotedAt: true },
    });

    const columns = toLeadColumns(input.collected, input.urgency);
    const status = nextLeadStatus(
      existing?.status,
      input.conversationComplete,
      hasAnyAnswer(input.collected),
    );

    // A silent reply must not clear an urgency an earlier one established. Dropping
    // the key entirely leaves the stored value untouched; setting it to null would
    // erase "this is urgent" the moment the customer answered a routine question.
    const { urgency, ...rest } = columns;
    const shared = {
      ...rest,
      ...(urgency === null ? {} : { urgency }),
      status,
      needsHuman: input.needsHuman,
      needsHumanReason: input.needsHumanReason,
      optedOut: input.optedOut ?? false,
      missingFields: input.stillMissing,
      // Which catalogue service this is for. Updated on every advance rather than
      // written once, because a customer can be re-asked and choose differently — the
      // lead must say what they settled on, not what they first said.
      serviceId: input.selectedServiceId ?? null,
      // The long tail, including fields with no column. The columns above are a
      // promoted subset, not a replacement — a question set the owner adds tomorrow
      // lands here without a migration.
      answers: input.collected as object,
    };

    const quote = quoteColumns(input.quote, existing?.quotedAt ?? null);

    const lead = await this.prisma.db.lead.upsert({
      where: { conversationId, businessId },
      create: {
        businessId,
        customerId: input.customerId,
        conversationId,
        ...shared,
        ...quote,
      },
      // Deliberately does not touch `ownerNotifiedAt`, `wonValueCents` or `closedAt`.
      // Those are written by the notification job and by the owner; a conversation
      // update must not reach into them, or a late reply would silently re-notify and
      // discard a recorded outcome.
      //
      // The quote fields are the exception, and `quoteColumns` is what makes it a safe
      // one: it returns nothing at all once a quote has been recorded, so a later reply
      // cannot rewrite the figure the customer was actually told.
      update: { ...shared, ...quote },
    });

    // Promote a learned name onto the customer, so the next call from this number is
    // from someone we can greet — and so the owner's lead SMS has more than a phone
    // number on it. Only when we have one and they do not: `upsertCustomer` refuses to
    // overwrite a known name with nothing, and this must not undo that.
    const learnedName = typeof input.collected.name === 'string' ? input.collected.name.trim() : '';
    if (learnedName.length > 0) {
      await this.prisma.db.customer.updateMany({
        where: { id: input.customerId, businessId, name: null },
        data: { name: learnedName },
      });
    }

    if (!existing) {
      this.logger.log(
        `Lead ${lead.id} created from conversation ${conversationId} (${status})` +
          (input.needsHuman ? ' — flagged for a human' : ''),
      );
    }

    return lead;
  }

  /**
   * Leads the owner has not been told about yet.
   *
   * The notification job's queue. `ownerNotifiedAt` is its idempotency key — texting
   * an owner the same lead twice is the kind of thing that gets the product turned
   * off.
   */
  async unnotified(businessId: string, limit = 50): Promise<Lead[]> {
    return this.prisma.db.lead.findMany({
      where: {
        businessId,
        ownerNotifiedAt: null,
        // Only leads worth interrupting someone for. A half-answered conversation
        // still in progress is not one.
        status: { in: ['QUALIFIED', 'QUOTED'] },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
}
