---
name: backend
description: NestJS and Prisma conventions for the API — multi-tenant businessId scoping and how to make a missing scope fail loudly, module layout, DTO validation, magic-link auth and session cookies, Prisma schema style and migration workflow, E.164 phone normalisation, money as integer cents, error handling, and the two entrypoints. Use when adding or changing anything under apps/api, writing a controller, service, guard or DTO, editing schema.prisma, running a migration, or handling phone numbers or currency on the server.
---

# Backend — NestJS + Prisma

One codebase, two entrypoints: `main.ts` (HTTP) and `worker.ts` (BullMQ processors). Same modules, same
image, different start command. Never a separate worker package — it duplicates bootstrap and drifts.

---

## 1. Tenancy — the rule that matters most

Every business's data must be invisible to every other business. This is the one bug class in this
product that is a genuine incident rather than an inconvenience.

### Where `businessId` comes from

Two sources, never the client:

| Context            | Source                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| Dashboard requests | The authenticated session, via a guard                                   |
| Twilio webhooks    | Looked up from the `To` number in `phone_numbers` — there is no session  |
| Job processors     | Read from `job.data`, put there by the producer that already resolved it |

**Never accept `businessId` in a DTO, query param, or request body.** Not "validate it against the
session" — don't accept it at all. A field that doesn't exist can't be forgotten.

```ts
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true, // strips unknown fields
    forbidNonWhitelisted: true, // 400 if the client sends one
    transform: true,
  }),
);
```

`whitelist` alone silently drops an injected `businessId`; `forbidNonWhitelisted` makes the attempt an
error. Prefer the loud version.

### Assert the scope, don't auto-inject it

The tempting design is a Prisma extension that quietly adds `where: { businessId }` to every query. Don't
— it hides missing scoping instead of surfacing it, and it can't work for webhooks and jobs where the
tenant comes from somewhere other than a session.

Assert instead. An unscoped query on a tenant model becomes a **runtime error**, not a silent leak:

```ts
const TENANT_MODELS = new Set([
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

prisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (TENANT_MODELS.has(model) && !isExempt(operation)) {
          assertBusinessIdInWhere(model, operation, args);
        }
        return query(args);
      },
    },
  },
});
```

Provide one explicit escape hatch — `prisma.unscoped()` — for the handful of legitimate cross-tenant
reads (resolving a webhook's `To` number, magic-link token lookup, maintenance sweeps). Escape hatches
are fine; _invisible_ escape hatches are not. Every call site of `unscoped()` should be greppable and
few.

### Cross-tenant access returns 404, not 403

`403` confirms the record exists. Return `404` for "not yours" and "not found" alike — the client
shouldn't be able to distinguish them.

### The test that enforces it

For every tenant model: seed business A and business B, authenticate as A, request B's record by id,
assert 404. Table-driven so a new model without a test is visible. Reviews miss scoping bugs; this
doesn't.

---

## 2. Module layout

Ten modules: `auth`, `businesses`, `services`, `telephony`, `calls`, `conversations`, `leads`,
`notifications`, `jobs`, `common` (+ `prisma`).

```
src/leads/
├── leads.module.ts
├── leads.controller.ts     # HTTP only — no business logic
├── leads.service.ts        # logic, takes businessId explicitly
├── dto/
│   ├── create-lead.dto.ts
│   └── update-lead.dto.ts
└── leads.service.spec.ts
```

- **Controllers are thin.** Parse, delegate, serialise. Anything conditional belongs in the service.
- **Services take `businessId` as an explicit first argument.** Even with the assertion extension in
  place — explicit beats ambient when the value comes from three different sources.
- **No cross-module imports of another module's service internals.** Import the module, inject the
  exported service.
- Don't split further until a module is genuinely large. Ceremony at this size costs more than it saves.

---

## 3. Auth: magic links

The owner is on a roof holding a phone. Passwords are hostile in that context, so the primary path is a
magic link in the lead SMS.

- Token: 32 bytes of CSPRNG randomness, **hashed** in the database (treat it like a password), short TTL
  (~15 min), **single use** — mark consumed inside the same transaction that issues the session.
- The link lands on a web route that exchanges the token for a session cookie, then redirects. Never
  leave the token in the final URL — referrer headers and browser history both leak it.
- Session cookie: `httpOnly`, `Secure`, `SameSite=Lax`, `Domain=.yourdomain.com`. The API and dashboard
  must share a registrable domain or this breaks — see the `frontend` skill.
- Argon2id if password login is added later. Not needed for the pilot.
- Rate limit token issuance per phone number; it's an SMS-sending endpoint, so abuse costs real money.

---

## 4. Prisma conventions

**Schema style**

- `camelCase` fields, `@@map("snake_case")` tables, `@map` on columns.
- `cuid()` ids. Sequential integers leak volume and enable enumeration across tenants.
- `createdAt` / `updatedAt` on every table.
- Prisma `enum` for closed sets (lead status, pricing type, suppression reason) — a string column with
  six valid values becomes a string column with nine within a month.
- Index `(businessId, createdAt)` on anything the dashboard lists; `@@unique([businessId, phoneE164])` on
  `customers`; `@@unique([provider, externalEventId])` on `webhook_events`.

**Migrations**

```
pnpm prisma migrate dev --name add_services     # local, generates SQL
pnpm prisma migrate deploy                       # CI and production
```

Never `db push` against anything holding data — it drops columns without asking. Read the generated SQL
before committing; Prisma occasionally chooses drop-and-recreate where you expected an alter.

The schema grows **table by table**, following the build protocol. Not all twelve at once.

**Money**

Integer cents, always. `priceCents Int`, never `Float` — binary floating point cannot represent 0.1, and
currency arithmetic in JS numbers accumulates error. Prisma `Decimal` is correct in the database but
awkward at the boundary; integer cents is unambiguous everywhere.

Format only at the edge, and always GST-inclusive when a caller will see it (`CLAUDE.md` rule 11).

---

## 5. Phone numbers

One helper in `common/phone.ts`, applied at every ingress point before anything else touches the value.

```ts
import { parsePhoneNumberFromString } from 'libphonenumber-js';
const parsed = parsePhoneNumberFromString(raw, 'AU');
return parsed?.isValid() ? parsed.number : null; // E.164
```

- `04xx xxx xxx`, `+614xxxxxxxx`, `(03) 9xxx xxxx` all arrive. Store E.164 only.
- **Withheld/anonymous caller ID** yields `null` — that is a valid state, not an error. Record the call,
  skip the SMS.
- Never compare, dedup or look up on a raw string. Every `phoneE164` column holds normalised values, and
  the uniqueness constraint depends on that being true.

---

## 6. Errors

- One global exception filter. Domain errors map to status codes; anything unrecognised becomes a 500
  with a correlation id and **no internal detail** in the response body.
- Typed domain exceptions (`LeadNotFoundError`, `ServiceUnavailableError`) rather than throwing
  `HttpException` from services — services shouldn't know they're behind HTTP, since half of them run
  inside workers.
- Log the correlation id, `businessId`, and route on every error. Without `businessId` in the log line,
  a production report of "it's broken" is unanswerable.

---

## 7. The two entrypoints

```ts
// main.ts — HTTP
const app = await NestFactory.create(AppModule, { rawBody: true });
app.set('trust proxy', 1); // signature validation depends on this
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
);

// worker.ts — jobs
const app = await NestFactory.createApplicationContext(AppModule);
// processors register themselves; no HTTP listener
```

`createApplicationContext` gives DI without a server. A worker that opens a port is a worker that gets
health-checked and restarted by a platform that thinks it's a web service.

---

## 8. Testing

- **Unit:** services with mocked dependencies. Fast, no I/O.
- **Integration:** real Postgres from docker-compose. Truncate between tests rather than re-migrating —
  an order of magnitude faster and it exercises the real constraints.
- **The tenancy suite** (§1) is table-driven over every tenant model.
- **Never mock Prisma.** Mocked query builders assert the shape of a call, not that the query is correct
  — they pass while the SQL is wrong.
- Assert on error _types_, not message strings.
