import { assertTenantScoped, TENANT_MODELS, TenantScopeError } from './tenant-guard';

// A representative tenant model and a representative non-tenant one. Using real
// names rather than fixtures so that renaming a model breaks these tests, which is
// the correct outcome — a renamed model that silently drops out of TENANT_MODELS is
// exactly the regression worth catching.
const TENANT = 'Lead';
const ROOT = 'Business';

const scoped = { where: { businessId: 'biz_1' } };

describe('tenant-guard: models outside the tenant set', () => {
  // Business IS the tenant; User is read during login and the magic-link exchange,
  // both of which happen before a businessId is known.
  it.each(['findUnique', 'findMany', 'create', 'delete', 'somethingNew'])(
    'allows %s on Business with no businessId',
    (operation) => {
      expect(() => assertTenantScoped(ROOT, operation, { where: { id: 'b1' } })).not.toThrow();
    },
  );

  it('allows unscoped queries on User', () => {
    expect(() =>
      assertTenantScoped('User', 'findUnique', { where: { email: 'a@b.com' } }),
    ).not.toThrow();
  });
});

describe('tenant-guard: findUnique is banned on tenant models', () => {
  // A unique lookup takes only unique fields, so it cannot carry a tenant
  // constraint. Allowing it would push the check into application code, which is
  // where it gets forgotten.
  it.each(['findUnique', 'findUniqueOrThrow'])('rejects %s', (operation) => {
    expect(() => assertTenantScoped(TENANT, operation, { where: { id: 'lead_1' } })).toThrow(
      TenantScopeError,
    );
  });

  it('rejects findUnique even when businessId is supplied', () => {
    // Not a loophole: Prisma would reject a non-unique field here anyway, and
    // permitting the shape would teach the wrong pattern.
    expect(() =>
      assertTenantScoped(TENANT, 'findUnique', { where: { id: 'lead_1', businessId: 'biz_1' } }),
    ).toThrow(TenantScopeError);
  });

  it('names findFirst in the error, so the fix is in the message', () => {
    expect(() => assertTenantScoped(TENANT, 'findUnique', { where: { id: 'x' } })).toThrow(
      /findFirst/,
    );
  });
});

describe('tenant-guard: where-scoped operations', () => {
  const operations = [
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
  ];

  it.each(operations)('allows %s with a top-level businessId', (operation) => {
    expect(() => assertTenantScoped(TENANT, operation, scoped)).not.toThrow();
  });

  it.each(operations)('rejects %s without businessId', (operation) => {
    expect(() => assertTenantScoped(TENANT, operation, { where: { status: 'NEW' } })).toThrow(
      TenantScopeError,
    );
  });

  it.each(operations)('rejects %s with no args at all', (operation) => {
    expect(() => assertTenantScoped(TENANT, operation, undefined)).toThrow(TenantScopeError);
  });

  it('rejects a missing where clause', () => {
    expect(() => assertTenantScoped(TENANT, 'findMany', {})).toThrow(TenantScopeError);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty filter object', {}],
  ])('rejects businessId that is %s', (_label, value) => {
    expect(() => assertTenantScoped(TENANT, 'findMany', { where: { businessId: value } })).toThrow(
      TenantScopeError,
    );
  });

  it('allows a businessId filter object such as { in: [...] }', () => {
    // Legitimate for a future multi-location owner viewing several businesses.
    expect(() =>
      assertTenantScoped(TENANT, 'findMany', { where: { businessId: { in: ['b1', 'b2'] } } }),
    ).not.toThrow();
  });
});

describe('tenant-guard: the OR trap', () => {
  // The whole reason the check is shallow. `OR: [{ businessId }, { status }]`
  // matches every business's NEW rows — a businessId inside OR scopes nothing.
  it('rejects businessId nested inside OR', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'findMany', {
        where: { OR: [{ businessId: 'biz_1' }, { status: 'NEW' }] },
      }),
    ).toThrow(TenantScopeError);
  });

  it('rejects businessId nested inside AND, even though AND would be safe', () => {
    // AND genuinely would scope the query, but allowing it means the guard has to
    // walk arbitrary boolean trees and decide which branches are load-bearing.
    // Requiring top-level keeps the rule one sentence long.
    expect(() =>
      assertTenantScoped(TENANT, 'findMany', {
        where: { AND: [{ businessId: 'biz_1' }] },
      }),
    ).toThrow(TenantScopeError);
  });

  it('allows top-level businessId alongside a nested OR', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'findMany', {
        where: { businessId: 'biz_1', OR: [{ status: 'NEW' }, { status: 'QUALIFIED' }] },
      }),
    ).not.toThrow();
  });
});

describe('tenant-guard: create operations', () => {
  it('allows create with businessId in data', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'create', { data: { businessId: 'biz_1', suburb: 'Southbank' } }),
    ).not.toThrow();
  });

  it('allows create via a business relation connect', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'create', {
        data: { business: { connect: { id: 'biz_1' } }, suburb: 'Southbank' },
      }),
    ).not.toThrow();
  });

  it('rejects create without a tenant', () => {
    expect(() => assertTenantScoped(TENANT, 'create', { data: { suburb: 'Southbank' } })).toThrow(
      TenantScopeError,
    );
  });

  it('rejects createMany when any row is missing businessId', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'createMany', {
        data: [{ businessId: 'biz_1' }, { suburb: 'Carlton' }],
      }),
    ).toThrow(TenantScopeError);
  });

  it('allows createMany when every row carries businessId', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'createMany', {
        data: [{ businessId: 'biz_1' }, { businessId: 'biz_1' }],
      }),
    ).not.toThrow();
  });

  it('allows an empty createMany — writing zero rows leaks nothing', () => {
    expect(() => assertTenantScoped(TENANT, 'createMany', { data: [] })).not.toThrow();
  });
});

describe('tenant-guard: upsert needs both halves', () => {
  it('allows upsert with businessId in where and create', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'upsert', {
        where: { businessId: 'biz_1', id: 'lead_1' },
        create: { businessId: 'biz_1' },
        update: {},
      }),
    ).not.toThrow();
  });

  it('rejects upsert scoped on where but not create', () => {
    // The insert branch is the one that would write a row into the wrong tenant.
    expect(() =>
      assertTenantScoped(TENANT, 'upsert', {
        where: { businessId: 'biz_1', id: 'lead_1' },
        create: { suburb: 'Southbank' },
        update: {},
      }),
    ).toThrow(TenantScopeError);
  });

  it('rejects upsert scoped on create but not where', () => {
    expect(() =>
      assertTenantScoped(TENANT, 'upsert', {
        where: { id: 'lead_1' },
        create: { businessId: 'biz_1' },
        update: {},
      }),
    ).toThrow(TenantScopeError);
  });
});

describe('tenant-guard: unknown operations fail closed', () => {
  // A Prisma upgrade that adds an operation must break loudly here rather than
  // quietly route around the guard.
  it('rejects an operation it does not recognise', () => {
    expect(() => assertTenantScoped(TENANT, 'findManyAndCount', scoped)).toThrow(TenantScopeError);
  });

  it('points at the constants to edit', () => {
    expect(() => assertTenantScoped(TENANT, 'someFutureOp', scoped)).toThrow(/WHERE_SCOPED/);
  });
});

describe('tenant-guard: errors are diagnosable', () => {
  it('carries the model and operation as fields, not just in the message', () => {
    // expect.assertions rather than a fail() in the try block: jest-circus does not
    // guarantee the global fail(), and this also proves the catch ran at all.
    expect.assertions(5);
    try {
      assertTenantScoped(TENANT, 'findMany', {});
    } catch (err) {
      expect(err).toBeInstanceOf(TenantScopeError);
      const e = err as TenantScopeError;
      expect(e.model).toBe(TENANT);
      expect(e.operation).toBe('findMany');
      expect(e.name).toBe('TenantScopeError');
      expect(e.message).toContain('[tenant-guard]');
    }
  });
});

describe('tenant-guard: the model list', () => {
  // Guards the guard. TENANT_MODELS lists models ahead of the schema on purpose, so
  // that a table is protected from its first line — this test documents the intent
  // and fails if someone prunes the list back to "only what exists today".
  it.each([
    'PhoneNumber',
    'Service',
    'Customer',
    'Call',
    'Conversation',
    'Message',
    'Lead',
    'Attachment',
    'Suppression',
  ])('includes %s', (model) => {
    expect(TENANT_MODELS.has(model)).toBe(true);
  });

  it.each(['Business', 'User'])('excludes %s — read before a tenant is known', (model) => {
    expect(TENANT_MODELS.has(model)).toBe(false);
  });
});
