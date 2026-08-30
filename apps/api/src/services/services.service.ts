import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CatalogueValidationError,
  DEFAULT_CLEANING_SERVICES,
  assertCatalogueValid,
  type CatalogueDraftEntry,
} from 'shared-types';
import { Prisma, type PriceConfidence, type PricingType, type Service, type ServiceAvailability } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The owner's service catalogue.
 *
 * This is the module the whole differentiator waits on. Until an owner can create a
 * service, every business has an empty catalogue, every caller gets the open-text
 * question instead of the numbered menu, and nothing is ever priced automatically —
 * the pricing engine, the menu, the quote wording and the lead's quote snapshot are all
 * built and all unreachable.
 *
 * **Every mutation validates the catalogue as it will be *after* the change, never the
 * incoming row on its own.** That is the central design decision here. A duplicate name,
 * a colliding sort position and a seventh active service are all properties of the whole
 * list — you cannot see any of them by looking at one service. So each method projects
 * the change onto the current catalogue, validates the projection, and only then writes.
 */

/** The fields an owner can set. Everything else is derived or reserved. */
export interface ServiceInput {
  name: string;
  description?: string | null;
  aliases?: string[];
  pricingType: PricingType;
  priceCents?: number | null;
  unitLabel?: string | null;
  minUnits?: number | null;
  maxUnits?: number | null;
  showPriceAutomatically?: boolean;
  priceConfidence?: PriceConfidence;
  requiresConfirmation?: boolean;
  requiredFields?: string[];
  availability?: ServiceAvailability;
}

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The whole catalogue in the owner's order, active and inactive alike. */
  async list(businessId: string): Promise<Service[]> {
    return this.prisma.db.service.findMany({
      where: { businessId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async get(businessId: string, id: string): Promise<Service> {
    const service = await this.prisma.db.service.findFirst({ where: { id, businessId } });
    // 404 rather than 403 for another tenant's id. A 403 confirms the row exists, which
    // is an enumeration oracle across businesses.
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  /**
   * Add a service.
   *
   * **New services go to the bottom**, at `max(sortOrder) + 1`. Prisma defaults the column
   * to `0`, which would collide with the first service and trip `SORT_ORDER_DUPLICATE` on
   * the very first create — a rule the owner cannot see and did not break. Appending is
   * also what they expect: a new service should not silently jump to the top of the menu
   * their customers see.
   */
  async create(businessId: string, input: ServiceInput): Promise<Service> {
    const existing = await this.list(businessId);
    const sortOrder = existing.reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1;

    const draft: CatalogueDraftEntry = {
      ...this.toDraft(input),
      name: input.name,
      sortOrder,
      availability: input.availability ?? 'ACTIVE',
    };
    assertCatalogueValid([...existing.map(toDraft), draft]);

    const service = await this.prisma.db.service.create({
      // The two required columns are named explicitly rather than spread, so a future
      // input shape that drops one is a compile error rather than a runtime failure.
      data: {
        businessId,
        sortOrder,
        name: input.name,
        pricingType: input.pricingType,
        ...this.toRow(input),
      },
    });
    this.logger.log(`Service ${service.id} created for business ${businessId}`);
    return service;
  }

  /**
   * Change a service.
   *
   * The projection matters here more than anywhere: renaming a service to one that
   * already exists, or switching a fifth service from disabled to active when six are
   * already on, are both only visible against the rest of the list.
   */
  async update(businessId: string, id: string, input: Partial<ServiceInput>): Promise<Service> {
    const existing = await this.list(businessId);
    const current = existing.find((s) => s.id === id);
    if (!current) throw new NotFoundException('Service not found');

    const projected = existing.map((s) =>
      s.id === id ? { ...toDraft(s), ...this.toDraft(input as ServiceInput), id } : toDraft(s),
    );
    assertCatalogueValid(projected);

    return this.prisma.db.service.update({
      where: { id, businessId },
      data: this.toRow(input),
    });
  }

  /**
   * Turn a service on or off.
   *
   * Separate from `update` because it is the one an owner reaches for most, and because
   * it is the operation that hits the six-active ceiling. Activating a seventh throws
   * `CatalogueValidationError` with a message naming the limit and how many to switch
   * off — the surplus is never silently dropped, and never silently trimmed from the
   * menu either (`buildServiceList` treats an over-sized catalogue as a configuration
   * error rather than something to quietly cut down).
   */
  async setAvailability(
    businessId: string,
    id: string,
    availability: ServiceAvailability,
  ): Promise<Service> {
    return this.update(businessId, id, { availability } as Partial<ServiceInput>);
  }

  /**
   * Remove a service.
   *
   * **Disable, do not delete** — unless nothing references it. `leads.serviceId` is
   * `SetNull`, so a hard delete would not orphan a lead, but it would erase which service
   * every past lead was about, and a quote the owner has to explain six months later is
   * worth more than a tidy table.
   *
   * A service nothing has referenced is a mistake being corrected rather than history
   * being kept, so that one is genuinely deleted.
   */
  async remove(businessId: string, id: string): Promise<{ deleted: boolean; service: Service }> {
    await this.get(businessId, id);

    const references = await this.prisma.db.lead.count({ where: { businessId, serviceId: id } });
    if (references > 0) {
      const service = await this.setAvailability(businessId, id, 'DISABLED');
      this.logger.log(
        `Service ${id} disabled rather than deleted — ${references} lead(s) reference it`,
      );
      return { deleted: false, service };
    }

    const service = await this.prisma.db.service.delete({ where: { id, businessId } });
    this.logger.log(`Service ${id} deleted (no leads referenced it)`);
    return { deleted: true, service };
  }

  /**
   * Reorder the menu.
   *
   * Takes the **whole list**, not one service and a position. Two reasons: it is the only
   * shape that can be validated atomically — a per-service move has an intermediate state
   * where two services share a position — and a drag-and-drop UI already has the whole
   * list in hand.
   *
   * Rejects a partial list. Silently leaving out a service would give it an unchanged
   * position that now collides with something, and the owner would have reordered their
   * menu into an invalid state without being told.
   */
  async reorder(businessId: string, orderedIds: string[]): Promise<Service[]> {
    const existing = await this.list(businessId);
    const known = new Set(existing.map((s) => s.id));

    const unknown = orderedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new NotFoundException(`Unknown service id(s): ${unknown.join(', ')}`);
    }
    if (orderedIds.length !== existing.length || new Set(orderedIds).size !== orderedIds.length) {
      throw new CatalogueValidationError([
        {
          code: 'SORT_ORDER_DUPLICATE',
          message:
            `Send every service exactly once when reordering — ${existing.length} expected, ` +
            `${orderedIds.length} received.`,
        },
      ]);
    }

    const position = new Map(orderedIds.map((id, index) => [id, index]));
    assertCatalogueValid(
      existing.map((s) => ({ ...toDraft(s), sortOrder: position.get(s.id) ?? s.sortOrder })),
    );

    // One transaction: a partial reorder is a menu whose positions collide, and the
    // customer-facing list would be built from it on the very next call.
    await this.prisma.db.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.db.service.update({ where: { id, businessId }, data: { sortOrder: index } }),
      ),
    );

    return this.list(businessId);
  }

  /**
   * Give a new business a starting catalogue.
   *
   * Called from onboarding, never automatically on read. Auto-seeding would mean a
   * business that deliberately cleared its catalogue gets it back, which is a product
   * fighting its user.
   *
   * **Refuses when a catalogue already exists** rather than merging, because merging
   * would silently reintroduce a service the owner deleted.
   *
   * The defaults carry no prices — all `MANUAL_QUOTE`. A default price would be a number
   * this system invented on a business's behalf and then quoted to their customers.
   */
  async seedDefaults(businessId: string): Promise<Service[]> {
    const existing = await this.list(businessId);
    if (existing.length > 0) {
      this.logger.log(`Business ${businessId} already has ${existing.length} service(s); not seeding`);
      return existing;
    }

    await this.prisma.db.service.createMany({
      data: DEFAULT_CLEANING_SERVICES.map((s) => ({
        businessId,
        name: s.name,
        sortOrder: s.sortOrder,
        pricingType: s.pricingType,
        showPriceAutomatically: s.showPriceAutomatically,
        availability: 'ACTIVE' as const,
      })),
    });

    this.logger.log(`Seeded ${DEFAULT_CLEANING_SERVICES.length} default services for ${businessId}`);
    return this.list(businessId);
  }

  /**
   * The subset of an input the shared validator reads.
   *
   * **Only keys that were actually supplied.** An earlier version defaulted the name to
   * `''` when absent, which meant every partial update — toggling availability, changing
   * a price, renaming nothing — projected an empty name onto the catalogue and was
   * rejected with "Give this service a name". A field that was not sent is a field the
   * owner did not touch, and the projection has to keep the stored value.
   */
  private toDraft(input: Partial<ServiceInput>): Partial<CatalogueDraftEntry> {
    const draft: Partial<CatalogueDraftEntry> = {};
    if (input.name !== undefined) draft.name = input.name;
    if (input.pricingType !== undefined) draft.pricingType = input.pricingType;
    if (input.priceCents !== undefined) draft.priceCents = input.priceCents;
    if (input.unitLabel !== undefined) draft.unitLabel = input.unitLabel;
    if (input.minUnits !== undefined) draft.minUnits = input.minUnits;
    if (input.maxUnits !== undefined) draft.maxUnits = input.maxUnits;
    if (input.availability !== undefined) draft.availability = input.availability;
    return draft;
  }

  /**
   * Only the keys actually supplied, so a PATCH does not null out omitted fields.
   *
   * That distinction is load-bearing: `priceCents: null` means "clear the price" and an
   * absent `priceCents` means "leave it alone", and collapsing the two would let a rename
   * silently wipe a price.
   */
  private toRow(input: Partial<ServiceInput>): ServiceRow {
    const row: Record<string, unknown> = {};
    for (const key of [
      'name', 'description', 'aliases', 'pricingType', 'priceCents', 'unitLabel',
      'minUnits', 'maxUnits', 'showPriceAutomatically', 'priceConfidence',
      'requiresConfirmation', 'requiredFields', 'availability',
    ] as const) {
      if (input[key] !== undefined) row[key] = input[key];
    }
    return row as ServiceRow;
  }
}

/**
 * The columns an owner may write, and nothing else.
 *
 * Narrower than `Prisma.ServiceUpdateInput` on purpose: that type also permits field
 * operations like `{ increment: 1 }`, which are meaningless here and would not fit the
 * create path. Derived from the generated type rather than hand-written, so a column
 * renamed in the schema breaks this at compile time.
 */
type ServiceRow = Partial<
  Pick<
    Prisma.ServiceUncheckedCreateInput,
    | 'name' | 'description' | 'aliases' | 'pricingType' | 'priceCents' | 'unitLabel'
    | 'minUnits' | 'maxUnits' | 'showPriceAutomatically' | 'priceConfidence'
    | 'requiresConfirmation' | 'requiredFields' | 'availability'
  >
>;

/** A stored row, as the shared validator sees it. */
function toDraft(service: Service): CatalogueDraftEntry {
  return {
    id: service.id,
    name: service.name,
    availability: service.availability,
    sortOrder: service.sortOrder,
    pricingType: service.pricingType,
    priceCents: service.priceCents,
    unitLabel: service.unitLabel,
    minUnits: service.minUnits,
    maxUnits: service.maxUnits,
  };
}
