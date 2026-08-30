# Uncommitted work — full report

Everything built since the last commit (`572087f — add interview prep script`). Nothing here is
committed; the working tree holds all of it.

**Headline:** the pilot loop is complete. An owner can configure a catalogue, a caller gets a numbered
menu and a price, a lead is produced, the owner is texted a working login, and they can open it and mark
it won. Verified in a real browser, not only in tests.

**Scale:** 44 files. ~2,900 lines of new source, ~1,250 lines changed in existing files. Jest went from
248 to **253 tests**.

---

## 1. Quick status

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` | 253 passed, 12 suites |
| Browser walkthrough | sign-in → hub → leads → lead detail → won → services, no console errors |

---

## 2. New files

### API — services module (the differentiator's front door)

| File | Lines | What it is |
| --- | ---: | --- |
| `services/services.service.ts` | 324 | Catalogue CRUD. Every mutation validates the **post-change** catalogue |
| `services/services.controller.ts` | 157 | `GET/POST/PATCH/DELETE /services`, `PUT /services/order`, `POST /services/seed-defaults` |
| `services/catalogue-validation.filter.ts` | 38 | Turns a `CatalogueValidationError` into a 422 with the issue array intact |
| `services/services.module.ts` | 21 | Wiring |
| `services/services.http.spec.ts` | 289 | 21 tests, including cross-tenant |

### API — leads API

| File | Lines | What it is |
| --- | ---: | --- |
| `leads/leads.controller.ts` | 94 | `GET /leads`, `GET /leads/summary`, `GET /leads/:id`, `PATCH /leads/:id` |
| `leads/leads.http.spec.ts` | 286 | 22 tests |

### API — the whole-product test

| File | Lines | What it is |
| --- | ---: | --- |
| `full-journey.spec.ts` | 260 | 8 tests walking the entire journey in order |

### Dashboard (all new)

| File | Lines | What it is |
| --- | ---: | --- |
| `lib/api.ts` | 199 | The one place the app talks to the API |
| `lib/format.ts` | 60 | Money, phone, relative time, room counts |
| `components/AppShell.tsx` | 87 | Session gate + navigation rail |
| `app/hub/page.tsx` | 225 | The landing page |
| `app/leads/page.tsx` | 181 | Inbox |
| `app/leads/[id]/page.tsx` | 215 | Lead detail — the screen the SMS link opens |
| `app/settings/services/page.tsx` | 378 | Catalogue editor |
| `app/signin/page.tsx` | 78 | Magic-link request |
| `app/auth/expired/page.tsx` | 25 | Where a dead link lands |

## 3. Modified files

| File | Change |
| --- | --- |
| `packages/shared-types/src/service-catalogue.ts` | +93 — `validateServicePricing`, five new issue codes |
| `apps/api/src/leads/leads.service.ts` | `list`, `get`, `setOutcome`, `summary` |
| `apps/api/src/auth/auth.service.ts` | **Magic link now points at the API, not the dashboard** |
| `apps/api/src/auth/auth.controller.ts` | Sign-in link surfaces in dev; `EMAIL_TRANSPORT_MISSING` in production |
| `apps/api/src/auth/auth.http.spec.ts` | +1 test pinning the link origin |
| `apps/api/src/leads/leads.module.ts` | Controller + `AuthModule` |
| `apps/api/src/app.module.ts` | Mounted `ServicesModule` |
| `apps/web/next.config.ts` | **`NEXT_PUBLIC_API_URL` derived from `PUBLIC_API_URL`** |
| `apps/web/src/app/globals.css` | Rewritten — the design system |
| `apps/web/src/app/page.tsx` | Redirects to `/hub` |
| `CLAUDE.md`, `docs/*` | Status and plan updates |

---

## 4. Five bugs found, and how

These matter more than the feature list — each was live, and three were invisible to the test suite.

### 4.1 The magic link 404 — **the worst one**

`mintLinkForUser` built the URL from `PUBLIC_WEB_URL` (port 3000), but `/auth/callback` is a route on the
**API** (3101). The dashboard has no such page, so every link produced a Next.js 404.

**This affected every lead SMS** — the primary owner surface (D6). Every lead text would have carried a
dead link.

**Why no test caught it:** every seed and probe script I wrote contained
`link.replace('localhost:3000', 'localhost:3101')`. I "fixed up" the value on the way into the test, so
the tests proved a URL I had corrected by hand, never the one the product emits. **Found by you clicking
it.**

Fixed, and pinned by a test that asserts the origin *and* issues the request against the server.

> **Lesson worth keeping:** never normalise a value on the way into a test. If the product's output needs
> correcting to be usable, that is the bug.

### 4.2 Two env vars for one thing

`.env` carried `NEXT_PUBLIC_API_URL=http://localhost:3001` — stale, from before the API moved to 3101 to
dodge a port collision. The dashboard called a dead port and showed *"could not reach the server"*, which
looks exactly like being offline.

Fixed structurally rather than by editing `.env`: `next.config.ts` now derives the browser's API origin
from `PUBLIC_API_URL`, which **cannot** silently drift — Twilio signature validation rebuilds its signed
string from it, so a wrong value there fails every webhook loudly.

> Your `.env` still contains the stale line. It is now inert, but worth deleting so nobody trusts it.

### 4.3 `PATCH /leads/:id` returned a different shape from `GET`

The update returned the bare row — no customer, no transcript — and the lead screen crashed on
`customer.name`. **Found by clicking**, because every existing test asserted only on fields the bare row
happened to have.

`setOutcome` now re-reads through `get`. A PATCH answering differently from a GET is a trap for every
future consumer.

### 4.4 A partial update wiped the name

`toDraft` defaulted a missing name to `''`, so **any** PATCH that did not resend the name — toggling
availability, changing a price — projected an empty name onto the catalogue and was rejected with "Give
this service a name". Caught by the services HTTP spec.

### 4.5 Typecheck and build were failing while I reported them clean

My new journey spec constructed `InboundMessageProcessor` with 6 arguments; it takes 7. Jest still passed
because the processor wraps the enqueue in a `try/catch` — so the test asserting *"the owner gets
notified"* passed while the notification was silently swallowed.

I had been counting `"Done"` lines with `grep` instead of checking exit codes. **I verify by exit code
now.**

---

## 5. The decisions worth knowing

### Services

| Decision | Why |
| --- | --- |
| Validate the **post-change** catalogue | A duplicate name, a colliding position and a seventh active service are properties of the whole list — invisible from one service |
| New services get `max(sortOrder) + 1` | Prisma defaults to `0`, which collides with the first service and trips a rule the owner never broke |
| `DELETE` disables when leads reference it | `leads.serviceId` is `SetNull`, so history survives either way — but a hard delete erases which service every past lead was about |
| Reorder takes the **whole list** | The only shape that validates atomically; a per-service move has an intermediate state where two positions collide |
| Defaults seeded explicitly, never on read | Auto-seeding means a business that deliberately cleared its catalogue gets it back |
| 422 with the **issue array intact** | The API returns every issue at once so a five-field mistake does not take five saves. Flattening at the HTTP boundary would waste that |

### Pricing validation — new, and not in the original plan

A `FIXED` service with no price now **cannot be saved**. `PriceCalculator` already refused to quote one
and fell through to a manual quote — correct at runtime and *completely invisible* to the owner. They set
a service to `FIXED`, forget the price, and never learn why no customer was quoted. Silent, permanent,
and it costs them the exact thing they bought the product for.

### Leads

- **Cursor pagination, not offset.** An inbox grows, and a lead arriving mid-scroll shifts every
  subsequent page with an offset — the owner sees the same record twice.
- **404 for another tenant's lead, never 403.** A 403 confirms the id exists.
- **`wonValueCents` only alongside `WON`.** A value on a lost lead corrupts the one metric that matters.
- **`NEW`/`QUALIFYING` are not owner-settable** — the conversation engine owns them, and letting a client
  set them would let the dashboard rewind a lead into a state the state machine disagrees with.

### The hub redesign

Modelled on the Evrystay pattern you sent. Their insight: an AI-native dashboard should open on
**reassurance**, not data — *"here's what the agent handled, here's the little that needs you."*

Ours opened on a raw list, which makes you read before you know whether reading was necessary. A cleaner
between jobs has about four seconds; most of the time the honest answer is *"the system handled it"*, and
a list cannot say that.

Adapted rather than copied:

- Their rail is desktop-only; ours is a **rail ≥768px and a bottom bar on a phone** — bottom, because the
  top of a modern phone is out of thumb reach one-handed.
- Kept 16px minimum type and 44px targets, which their desktop-first design does not need and our user
  does.
- **Colour is never the only signal** — every badge carries a word.
- `SOON` badges on what is genuinely unbuilt.

### `GET /leads/summary`

- **Declared before `@Get(':id')`** — otherwise Nest matches it as a lead with the id `"summary"`. There
  is a test for that regression.
- **"This week" is a rolling 7×24h window**, not a calendar week — calendar boundaries need the business
  timezone and break twice a year on DST (rule 12).
- **`valueCents` is null, not zero**, when jobs were won without a recorded amount. *"Jobs, but you did
  not say what they were worth"* is a different fact from *"no jobs"*, and the tile says so.

---

## 6. What still does not work

Stated plainly, because some of it looks finished and is not.

| Gap | Impact |
| --- | --- |
| **No email transport** | The sign-in form mints a link and prints it in the terminal in development. In production it logs `EMAIL_TRANSPORT_MISSING` and sends nothing. The SMS path is the real one and works |
| **No rate limit on `POST /auth/request-link`** | Unauthenticated, writes to `users` on every call. Not an enumeration oracle — responses are identical — but it needs a per-address throttle before facing the internet |
| **Everything external is faked** | `FakeSmsProvider` and `FakeLlmProvider`. The server says so on boot. Real conversations need `TWILIO_*` and `ANTHROPIC_API_KEY` |
| **No business settings** | Name, timezone, GST flag, notify number — all SQL-only. Fine for three pilots |
| **No manual reply, no photos** | Both deferred; neither blocks a pilot |
| **No deploy, CI, or Sentry** | Deployment is blocked by the carrier test, not by code |

### And the two that gate everything

1. **The carrier forwarding test.** ~A$15, three SIMs, an afternoon. If Telstra/Optus/Vodafone do not
   preserve the caller's number on a forwarded leg, there is nobody to text and the architecture changes.
   Every line above assumes it works.
2. **Extraction has never run against a real model.** Every conversation test uses `FakeLlmProvider`.

---

## 7. Housekeeping before you commit

Two things in the working tree that should **not** be committed:

- `.playwright-mcp/` — 27 browser snapshot files from my testing
- `hub.png`, `leads-inbox.png` — screenshot attempts

Add to `.gitignore`:

```
.playwright-mcp/
*.png
```

Also worth doing: delete the stale `NEXT_PUBLIC_API_URL` line from `.env` (§4.2). It is inert now, but a
misleading variable is a trap for whoever reads it next.

---

## 8. Suggested commit split

Rather than one large commit, four that each stand alone:

1. **`add pricing validation to the shared catalogue rules`** — `shared-types`
2. **`add the services module: catalogue CRUD over HTTP`** — services service, controller, filter,
   module, spec, app wiring
3. **`add the leads API: inbox, detail, outcomes, hub summary`** — leads service, controller, spec
4. **`add the dashboard`** — all of `apps/web`, plus the `next.config.ts` API-origin fix
5. **`fix the magic link pointing at the dashboard instead of the API`** — auth service + spec. Worth its
   own commit; it is the bug that broke every lead SMS

Then `full-journey.spec.ts` and the doc updates with whichever of those they belong to.
