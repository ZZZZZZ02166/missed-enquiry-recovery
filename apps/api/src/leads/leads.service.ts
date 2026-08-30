import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CollectedAnswers, FieldKey } from '../conversations/question-flow';
import type { LeadStatus } from '../generated/prisma/client';
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

/** How the owner filters their inbox. Every field optional; absent means "all". */
export interface LeadListFilters {
  status?: LeadStatus;
  needsHuman?: boolean;
  /** Opaque cursor — the id of the last lead on the previous page. */
  cursor?: string;
  limit?: number;
}

/** Statuses an owner may set by hand. `NEW` and `QUALIFYING` are the machine's to set. */
export const OWNER_SETTABLE_STATUSES: readonly LeadStatus[] = ['QUOTED', 'WON', 'LOST'];

/** What the hub renders. Counts, not rows — see `summary`. */
export interface LeadSummaryCounts {
  /** Open leads the conversation flagged for a person. The only urgent number here. */
  needsAttention: number;
  /** Everything not yet won or lost. */
  openLeads: number;
  /** Quoted and waiting on the customer. */
  quoted: number;
  /** Arrived in the last 24 hours. */
  newToday: number;
  wonThisWeek: { count: number; valueCents: number | null };
}

/** A page of leads plus the cursor for the next one. */
export interface LeadPage {
  leads: unknown[];
  nextCursor: string | null;
}

/** Sensible page size for a phone. Bounded so a client cannot ask for everything. */
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The owner's inbox.
   *
   * **Cursor pagination, not offset.** An inbox grows and `OFFSET 500` makes the database
   * walk five hundred rows to throw them away. A cursor is also stable while new leads
   * arrive — with an offset, a lead landing mid-scroll shifts every subsequent page and
   * the owner sees the same record twice.
   *
   * Ordered newest first, because a lead from four minutes ago is worth more than one
   * from yesterday: this whole product exists to beat whoever calls back first.
   */
  async list(businessId: string, filters: LeadListFilters = {}): Promise<LeadPage> {
    const take = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);

    const leads = await this.prisma.db.lead.findMany({
      where: {
        businessId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.needsHuman === undefined ? {} : { needsHuman: filters.needsHuman }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row, purely to answer "is there another page?" without a second query.
      take: take + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      include: {
        customer: { select: { name: true, phoneE164: true } },
        service: { select: { name: true } },
      },
    });

    const page = leads.slice(0, take);
    return {
      leads: page,
      nextCursor: leads.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * The hub's summary — what happened while the owner was on a roof.
   *
   * Counts rather than rows, because the landing page answers one question: *do I need
   * to do anything right now?* A list cannot answer that at a glance; a number can.
   *
   * "This week" is a rolling 7×24h window rather than a calendar week, deliberately.
   * Calendar boundaries need `businesses.timezone` and break twice a year on DST
   * (rule 12); a rolling window is timezone-independent and means the same thing to
   * everyone.
   *
   * One query per bucket rather than a `groupBy`, because the buckets are not disjoint —
   * a lead can be both new and needing attention — and a grouped count would force the
   * caller to reassemble them and get that overlap wrong.
   */
  async summary(businessId: string): Promise<LeadSummaryCounts> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const open = { in: ['NEW', 'QUALIFYING', 'QUALIFIED', 'QUOTED'] as LeadStatus[] };

    const [needsAttention, openLeads, quoted, newToday, wonThisWeek] = await Promise.all([
      this.prisma.db.lead.count({ where: { businessId, needsHuman: true, status: open } }),
      this.prisma.db.lead.count({ where: { businessId, status: open } }),
      this.prisma.db.lead.count({ where: { businessId, status: 'QUOTED' } }),
      this.prisma.db.lead.count({ where: { businessId, createdAt: { gte: dayAgo } } }),
      this.prisma.db.lead.aggregate({
        where: { businessId, status: 'WON', closedAt: { gte: weekAgo } },
        _count: true,
        _sum: { wonValueCents: true },
      }),
    ]);

    return {
      needsAttention,
      openLeads,
      quoted,
      newToday,
      wonThisWeek: {
        count: wonThisWeek._count,
        // Null when every won lead was recorded without a value — which is common, since
        // the value is optional. Null and zero mean different things to the owner: "no
        // jobs" versus "jobs, but you didn't tell us what they were worth".
        valueCents: wonThisWeek._sum.wonValueCents,
      },
    };
  }

  /**
   * One lead, with the conversation that produced it.
   *
   * The transcript is included because the owner's first question about any lead is
   * "what did they actually say" — and the answer is the difference between calling back
   * prepared and calling back cold.
   */
  async get(businessId: string, id: string) {
    const lead = await this.prisma.db.lead.findFirst({
      where: { id, businessId },
      include: {
        customer: { select: { name: true, phoneE164: true, lineType: true } },
        service: { select: { name: true, pricingType: true } },
        conversation: {
          select: { id: true, state: true, collected: true, questionsAsked: true, lastInboundAt: true },
        },
      },
    });

    // 404, never 403: a 403 confirms the id exists, which lets one business enumerate
    // another's leads by probing ids.
    if (!lead) throw new NotFoundException('Lead not found');

    const messages = await this.prisma.db.message.findMany({
      where: { businessId, customerId: lead.customerId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, direction: true, body: true, status: true,
        purpose: true, createdAt: true, sentAt: true,
      },
    });

    return { ...lead, messages };
  }

  /**
   * The owner marks an outcome.
   *
   * **This is the only writer of `wonValueCents` and `closedAt`**, and it is the metric
   * the entire renewal conversation rests on — "we recovered $2,400 of work you would
   * have lost" is the sentence that keeps a subscription. `nextLeadStatus` already
   * refuses to regress past an owner-set outcome, so a late customer reply cannot undo
   * this.
   *
   * `wonValueCents` is accepted only alongside `WON`. A value attached to a lost lead is
   * either a mistake or a misunderstanding of the field, and silently storing it would
   * corrupt the one number that matters.
   */
  async setOutcome(
    businessId: string,
    id: string,
    input: { status?: LeadStatus; wonValueCents?: number | null; lostReason?: string | null; needsHuman?: boolean },
  ) {
    const existing = await this.prisma.db.lead.findFirst({
      where: { id, businessId },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException('Lead not found');

    const status = input.status ?? existing.status;
    const closing = status === 'WON' || status === 'LOST';

    await this.prisma.db.lead.update({
      where: { id, businessId },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.needsHuman === undefined ? {} : { needsHuman: input.needsHuman }),
        ...(status === 'WON' && input.wonValueCents !== undefined
          ? { wonValueCents: input.wonValueCents }
          : {}),
        ...(status === 'LOST' && input.lostReason !== undefined
          ? { lostReason: input.lostReason }
          : {}),
        // Set on the transition, and left alone afterwards — re-marking a won lead as
        // won should not move the date it closed.
        ...(closing ? { closedAt: new Date() } : {}),
      },
    });

    this.logger.log(`Lead ${id} marked ${status} by the owner`);

    // Re-read through `get` so a PATCH answers with exactly the shape a GET does —
    // customer, service, conversation and transcript included. Returning the bare
    // updated row instead is a trap: the caller has a `LeadDetail` before the request
    // and something narrower after it, and every consumer has to know that. The
    // dashboard crashed on precisely this reaching for `customer.name`.
    return this.get(businessId, id);
  }

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
