import type { LeadStatus, LeadUrgency, PropertyType } from '../generated/prisma/client';
import type { CollectedAnswers } from '../conversations/question-flow';

/**
 * The translation from what a conversation collected into what a lead stores.
 *
 * Pure and separate from the service because it is the part with edges. `collected`
 * is `Partial<Record<FieldKey, unknown>>` — deliberately untyped, because it comes
 * from a JSON column that a model wrote into. Everything here narrows at runtime
 * rather than trusting a cast, and anything unrecognised becomes null rather than
 * throwing: a lead with a missing bedroom count is still a lead the owner can act on,
 * while an exception in the processor loses the whole reply.
 *
 * The specific trap this closes: **extraction emits lowercase (`'apartment'`,
 * `'high'`) and the database enums are uppercase.** Handing one to the other fails at
 * write time with a Prisma validation error, which in the processor means a retry
 * loop rather than a lead.
 */

const PROPERTY_TYPES: Record<string, PropertyType> = {
  house: 'HOUSE',
  apartment: 'APARTMENT',
  townhouse: 'TOWNHOUSE',
  unit: 'UNIT',
  other: 'OTHER',
};

const URGENCIES: Record<string, LeadUrgency> = {
  low: 'LOW',
  normal: 'NORMAL',
  high: 'HIGH',
};

/** Matches the extraction bound. A value outside it is a misread, not a big house. */
const MAX_ROOMS = 20;

export interface LeadAnswerColumns {
  serviceType: string | null;
  suburb: string | null;
  propertyType: PropertyType | null;
  bedrooms: number | null;
  bathrooms: number | null;
  carpetedRooms: number | null;
  preferredDate: string | null;
  urgency: LeadUrgency | null;
}

/**
 * Promote the subset of answers that have typed columns.
 *
 * The rest stays in `answers` JSON — these are promoted because the pricing matrix
 * has to compute over them in SQL and the dashboard groups by them.
 */
export function toLeadColumns(
  collected: CollectedAnswers,
  // Separate argument, not a field of `collected`. Urgency is a *signal* — the
  // conversation never asks about it, and extraction deliberately keeps it out of the
  // answers so it cannot masquerade as a satisfied question (see `extraction.ts`).
  urgency?: unknown,
): LeadAnswerColumns {
  return {
    serviceType: text(collected.serviceType),
    suburb: text(collected.suburb),
    propertyType: enumOf(collected.propertyType, PROPERTY_TYPES),
    bedrooms: roomCount(collected.bedrooms),
    bathrooms: roomCount(collected.bathrooms),
    carpetedRooms: roomCount(collected.carpetedRooms),
    preferredDate: text(collected.preferredDate),
    urgency: enumOf(urgency, URGENCIES),
  };
}

/**
 * Where a lead sits in the owner's pipeline, given the conversation.
 *
 * **Never regresses a status the owner set.** `QUOTED`, `WON` and `LOST` are outcomes
 * a person recorded; a customer replying again afterwards reopens the conversation,
 * and without this guard the next sync would quietly drag a won job back to
 * `QUALIFYING`. Same shape as the clobber bug in the outbox: an unconditional write
 * that moves state backwards.
 */
export function nextLeadStatus(
  current: LeadStatus | undefined,
  conversationComplete: boolean,
  hasAnyAnswer: boolean,
): LeadStatus {
  if (current === 'QUOTED' || current === 'WON' || current === 'LOST') return current;
  if (conversationComplete) return 'QUALIFIED';
  return hasAnyAnswer ? 'QUALIFYING' : 'NEW';
}

/** Anything the conversation learned, including fields with no column of their own. */
export function hasAnyAnswer(collected: CollectedAnswers): boolean {
  return Object.values(collected).some((v) => v !== undefined && v !== null && v !== '');
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Numbers only, and only plausible ones.
 *
 * `0` is a real answer — a studio has zero bedrooms — so this cannot use truthiness,
 * the same trap `hasAnswer` in the question flow exists to avoid.
 */
function roomCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 0 && rounded <= MAX_ROOMS ? rounded : null;
}

/**
 * Case-insensitive because the source is a language model.
 *
 * Extraction constrains these to a lowercase enum, but `collected` is persisted JSON
 * that predates any given version of that schema — a value stored last month is not
 * re-validated when it is read back.
 */
function enumOf<T>(value: unknown, table: Record<string, T>): T | null {
  if (typeof value !== 'string') return null;
  return table[value.trim().toLowerCase()] ?? null;
}
