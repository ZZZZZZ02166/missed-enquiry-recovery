import { Injectable, Logger } from '@nestjs/common';
import type { CollectedAnswers, FieldKey } from '../conversations/question-flow';
import type { Lead } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
      select: { id: true, status: true },
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
      // The long tail, including fields with no column. The columns above are a
      // promoted subset, not a replacement — a question set the owner adds tomorrow
      // lands here without a migration.
      answers: input.collected as object,
    };

    const lead = await this.prisma.db.lead.upsert({
      where: { conversationId, businessId },
      create: {
        businessId,
        customerId: input.customerId,
        conversationId,
        ...shared,
      },
      // Deliberately does not touch `ownerNotifiedAt`, the quote fields, `wonValueCents`
      // or `closedAt`. Those are written by the notification job and by the owner; a
      // conversation update must not reach into them, or a late reply would silently
      // re-notify and discard a recorded outcome.
      update: shared,
    });

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
