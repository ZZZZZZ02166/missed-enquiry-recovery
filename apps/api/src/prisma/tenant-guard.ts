import { Prisma } from '../generated/prisma/client';

/**
 * Multi-tenant safety net (docs/decisions.md D8).
 *
 * Throws when a query against a tenant-scoped model does not constrain by
 * `businessId`. One business reading another's customer list is the only bug class
 * in this product that is a genuine incident rather than an inconvenience, and code
 * review does not reliably catch a missing where-clause.
 *
 * This ASSERTS rather than auto-injecting. An extension that silently added
 * `where: { businessId }` would hide missing scoping instead of surfacing it — it
 * fails *open* on the first query shape it doesn't cover — and it cannot work at all
 * for Twilio webhooks or job processors, where the tenant comes from a phone-number
 * lookup or `job.data` rather than a session.
 */

/**
 * Models carrying a `businessId`. Listed ahead of the schema deliberately: a model
 * is guarded from its first line rather than from whenever someone remembers to add
 * it here. Names not yet in the schema are simply never queried.
 *
 * `Business` and `User` are absent on purpose — `Business` *is* the tenant, and both
 * are legitimately read before a tenant is known (login, magic-link exchange).
 */
export const TENANT_MODELS = new Set([
  'PhoneNumber',
  'Service',
  'Customer',
  'Call',
  'Conversation',
  'Message',
  'Lead',
  'Attachment',
  'Suppression',
]);

/** Operations that must constrain by `businessId` in `where`. */
const WHERE_SCOPED = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations that must carry `businessId` in `data`. */
const DATA_SCOPED = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Banned on tenant models.
 *
 * `findUnique({ where: { id } })` cannot express a tenant constraint — a unique
 * lookup takes only unique fields, so the query is by definition cross-tenant and
 * the check has to happen afterwards in application code, where it gets forgotten.
 * `findFirst({ where: { id, businessId } })` pushes the constraint into the query
 * itself and returns null for another tenant's row, which is exactly the 404-not-403
 * behaviour we want.
 */
const BANNED = new Set(['findUnique', 'findUniqueOrThrow']);

export class TenantScopeError extends Error {
  constructor(
    readonly model: string,
    readonly operation: string,
    detail: string,
  ) {
    super(`[tenant-guard] ${model}.${operation}: ${detail}`);
    this.name = 'TenantScopeError';
  }
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * True when `businessId` is constrained at the top level.
 *
 * Deliberately shallow: a `businessId` buried inside `OR` does not scope a query —
 * `OR: [{ businessId }, { status: 'NEW' }]` matches every business's NEW rows. Put
 * `businessId` at the top level and nest the rest.
 */
function hasTopLevelBusinessId(where: unknown): boolean {
  if (!isRecord(where)) return false;
  const value = where['businessId'];
  if (value === undefined || value === null) return false;
  // `{ businessId: { in: [] } }` is a legitimate constraint; `{ businessId: {} }` is not.
  if (isRecord(value) && Object.keys(value).length === 0) return false;
  return true;
}

/** True when create-data supplies the tenant, either directly or via a relation connect. */
function dataHasBusiness(data: unknown): boolean {
  if (!isRecord(data)) return false;
  if (data['businessId'] !== undefined && data['businessId'] !== null) return true;

  // `data: { business: { connect: { id } } }`
  const business = data['business'];
  if (isRecord(business) && isRecord(business['connect'])) return true;

  return false;
}

/**
 * The check itself, extracted from the extension so it can be unit-tested without a
 * database. Throws `TenantScopeError`, or returns silently.
 */
export function assertTenantScoped(model: string, operation: string, args: unknown): void {
  if (!TENANT_MODELS.has(model)) return;

  if (BANNED.has(operation)) {
    throw new TenantScopeError(
      model,
      operation,
      `not permitted on a tenant model — a unique lookup cannot carry a tenant constraint. ` +
        `Use findFirst({ where: { id, businessId } }) instead.`,
    );
  }

  const a = isRecord(args) ? args : {};

  if (WHERE_SCOPED.has(operation)) {
    if (!hasTopLevelBusinessId(a['where'])) {
      throw new TenantScopeError(
        model,
        operation,
        `missing businessId in where. It must be top-level — a businessId inside OR does not scope ` +
          `the query. If this is genuinely cross-tenant, use prisma.unscoped and say why.`,
      );
    }
    return;
  }

  if (DATA_SCOPED.has(operation)) {
    const data = a['data'];
    const rows = Array.isArray(data) ? data : [data];
    // createMany with an empty array writes nothing; nothing to leak.
    if (rows.length === 0) return;
    if (!rows.every(dataHasBusiness)) {
      throw new TenantScopeError(
        model,
        operation,
        `missing businessId in data (every row must carry it, directly or via business.connect).`,
      );
    }
    return;
  }

  if (operation === 'upsert') {
    if (!hasTopLevelBusinessId(a['where'])) {
      throw new TenantScopeError(model, operation, `missing businessId in where.`);
    }
    if (!dataHasBusiness(a['create'])) {
      throw new TenantScopeError(model, operation, `missing businessId in create.`);
    }
    return;
  }

  // Unrecognised operation on a tenant model. Fail closed: a Prisma upgrade that
  // adds an operation should break loudly here rather than quietly bypass the guard.
  throw new TenantScopeError(
    model,
    operation,
    `unrecognised operation — tenant-guard does not know how to scope it. Add it to ` +
      `WHERE_SCOPED or DATA_SCOPED in tenant-guard.ts once you have decided what scoping means for it.`,
  );
}

/**
 * The Prisma client extension. Apply once, in PrismaService.
 *
 * Note this cannot see `$queryRaw` / `$executeRaw` — raw SQL is not a model
 * operation and bypasses the guard entirely. Raw queries against tenant tables must
 * carry their own `WHERE business_id = ...`, and there should be very few of them.
 */
export const tenantGuard = Prisma.defineExtension({
  name: 'tenant-guard',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        assertTenantScoped(model, operation, args);
        return query(args);
      },
    },
  },
});
