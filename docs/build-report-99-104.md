# Build report — the services module, leads API and dashboard

The services module, the leads API and the dashboard — everything built after `572087f`, committed
across six commits from `bf745e5` to `8208a15`. Companion to `docs/build-report-92-98.md`, which covers
the CI currency guard and the auth module.

**Every explanation names the file and line to open.** Line numbers are accurate as of `8208a15`; if
the code has moved, search for the function name instead.

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
| `apps/api/src/services/services.service.ts` | 324 | Catalogue CRUD. Every mutation validates the **post-change** catalogue |
| `apps/api/src/services/services.controller.ts` | 157 | `GET/POST/PATCH/DELETE /services`, `PUT /services/order`, `POST /services/seed-defaults` |
| `apps/api/src/services/catalogue-validation.filter.ts` | 38 | Turns a `CatalogueValidationError` into a 422 with the issue array intact |
| `apps/api/src/services/services.module.ts` | 21 | Wiring |
| `apps/api/src/services/services.http.spec.ts` | 289 | 21 tests, including cross-tenant |

### API — leads API

| File | Lines | What it is |
| --- | ---: | --- |
| `apps/api/src/leads/leads.controller.ts` | 94 | `GET /leads`, `GET /leads/summary`, `GET /leads/:id`, `PATCH /leads/:id` |
| `apps/api/src/leads/leads.http.spec.ts` | 286 | 22 tests |

### API — the whole-product test

| File | Lines | What it is |
| --- | ---: | --- |
| `apps/api/src/full-journey.spec.ts` | 260 | 8 tests walking the entire journey in order |

### Dashboard (all new)

| File | Lines | What it is |
| --- | ---: | --- |
| `apps/web/src/lib/api.ts` | 199 | The one place the app talks to the API |
| `apps/web/src/lib/format.ts` | 60 | Money, phone, relative time, room counts |
| `apps/web/src/components/AppShell.tsx` | 87 | Session gate + navigation rail |
| `apps/web/src/app/hub/page.tsx` | 225 | The landing page |
| `apps/web/src/app/leads/page.tsx` | 181 | Inbox |
| `apps/web/src/app/leads/[id]/page.tsx` | 215 | Lead detail — the screen the SMS link opens |
| `apps/web/src/app/settings/services/page.tsx` | 378 | Catalogue editor |
| `apps/web/src/app/signin/page.tsx` | 78 | Magic-link request |
| `apps/web/src/app/auth/expired/page.tsx` | 25 | Where a dead link lands |

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

> **Open:** `apps/api/src/auth/auth.service.ts:75` — the one line, with the reasoning above it
> **Test:** `apps/api/src/auth/auth.http.spec.ts:79` — *"THE 404 BUG"*
> **Commit:** `1a5415c`

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

> **Open:** `apps/web/next.config.ts:27` — the derivation, with the full reasoning in the comment above
> **Consumer:** `apps/web/src/lib/api.ts:19`
> **Commit:** `32211c5`

`.env` carried `NEXT_PUBLIC_API_URL=http://localhost:3001` — stale, from before the API moved to 3101 to
dodge a port collision. The dashboard called a dead port and showed *"could not reach the server"*, which
looks exactly like being offline.

Fixed structurally rather than by editing `.env`: `next.config.ts` now derives the browser's API origin
from `PUBLIC_API_URL`, which **cannot** silently drift — Twilio signature validation rebuilds its signed
string from it, so a wrong value there fails every webhook loudly.

> Your `.env` still contains the stale line. It is now inert, but worth deleting so nobody trusts it.

### 4.3 `PATCH /leads/:id` returned a different shape from `GET`

> **Open:** `apps/api/src/leads/leads.service.ts:264` — `setOutcome`, and the comment on why it re-reads
> **Test:** `apps/api/src/leads/leads.http.spec.ts` — *"answers a PATCH with the same shape as a GET"*
> **Crashed here:** `apps/web/src/app/leads/[id]/page.tsx:51` — `markWon` renders the response directly
> **Commit:** `0a84235`

The update returned the bare row — no customer, no transcript — and the lead screen crashed on
`customer.name`. **Found by clicking**, because every existing test asserted only on fields the bare row
happened to have.

`setOutcome` now re-reads through `get`. A PATCH answering differently from a GET is a trap for every
future consumer.

### 4.4 A partial update wiped the name

> **Open:** `apps/api/src/services/services.service.ts:262` — `toDraft`, and why it only returns supplied keys
> **Affected:** `apps/api/src/services/services.service.ts:109` — `update`, which builds the projection
> **Commit:** `667ce7a`

`toDraft` defaulted a missing name to `''`, so **any** PATCH that did not resend the name — toggling
availability, changing a price — projected an empty name onto the catalogue and was rejected with "Give
this service a name". Caught by the services HTTP spec.

### 4.5 Typecheck and build were failing while I reported them clean

> **Open:** `apps/api/src/full-journey.spec.ts:70` — the captured notify queue and why it is not mocked away
> **Commit:** `8208a15`

My new journey spec constructed `InboundMessageProcessor` with 6 arguments; it takes 7. Jest still passed
because the processor wraps the enqueue in a `try/catch` — so the test asserting *"the owner gets
notified"* passed while the notification was silently swallowed.

I had been counting `"Done"` lines with `grep` instead of checking exit codes. **I verify by exit code
now.**

---

## 5. The decisions worth knowing

### Services

| Decision | Why | Open |
| --- | --- | --- |
| Validate the **post-change** catalogue | A duplicate name, a colliding position and a seventh active service are properties of the whole list — invisible from one service | `services.service.ts:75` (create), `:109` (update) |
| New services get `max(sortOrder) + 1` | Prisma defaults to `0`, which collides with the first service and trips a rule the owner never broke | `services.service.ts:75` |
| `DELETE` disables when leads reference it | `leads.serviceId` is `SetNull`, so history survives either way — but a hard delete erases which service every past lead was about | `services.service.ts:154` |
| Reorder takes the **whole list** | The only shape that validates atomically; a per-service move has an intermediate state where two positions collide | `services.service.ts:183`, route at `services.controller.ts:146` |
| Defaults seeded explicitly, never on read | Auto-seeding means a business that deliberately cleared its catalogue gets it back | `services.service.ts:231` |
| 422 with the **issue array intact** | The API returns every issue at once so a five-field mistake does not take five saves. Flattening at the HTTP boundary would waste that | `catalogue-validation.filter.ts:20` |

All paths above are under `apps/api/src/services/`. The HTTP surface is
`apps/api/src/services/services.controller.ts` — `@Get()` 93, `@Post()` 103, `@Patch(':id')` 108,
`@Patch(':id/availability')` 124, `@Delete(':id')` 140, `@Put('order')` 146, `@Post('seed-defaults')` 153.

### Pricing validation — new, and not in the original plan

> **Open:** `packages/shared-types/src/service-catalogue.ts:135` — `validateServicePricing`
> **Used by the server:** `apps/api/src/services/services.service.ts:75`
> **Used by the form, live as you type:** `apps/web/src/app/settings/services/page.tsx:89`

A `FIXED` service with no price now **cannot be saved**. `PriceCalculator` already refused to quote one
and fell through to a manual quote — correct at runtime and *completely invisible* to the owner. They set
a service to `FIXED`, forget the price, and never learn why no customer was quoted. Silent, permanent,
and it costs them the exact thing they bought the product for.

### Leads

> **Open:** `apps/api/src/leads/leads.service.ts` — `list` 143, `summary` 184, `get` 223, `setOutcome` 264
> **Routes:** `apps/api/src/leads/leads.controller.ts` — `summary` 75, `:id` 81, `PATCH` 86

- **Cursor pagination, not offset.** An inbox grows, and a lead arriving mid-scroll shifts every
  subsequent page with an offset — the owner sees the same record twice.
- **404 for another tenant's lead, never 403.** A 403 confirms the id exists.
- **`wonValueCents` only alongside `WON`.** A value on a lost lead corrupts the one metric that matters.
- **`NEW`/`QUALIFYING` are not owner-settable** — the conversation engine owns them, and letting a client
  set them would let the dashboard rewind a lead into a state the state machine disagrees with.

### The hub redesign

> **Open:** `apps/web/src/app/hub/page.tsx:76` — `Hub`, and `:103` for the "all caught up" condition
> **Navigation:** `apps/web/src/components/AppShell.tsx:23`
> **Design system:** `apps/web/src/app/globals.css`

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

> **Open:** `apps/api/src/leads/leads.controller.ts:75` — note it sits *above* `@Get(':id')` at `:81`
> **Query:** `apps/api/src/leads/leads.service.ts:184`

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
| **No email transport** | The sign-in form mints a link and prints it in the terminal in development. In production it logs `EMAIL_TRANSPORT_MISSING` and sends nothing. The SMS path is the real one and works — `apps/api/src/auth/auth.controller.ts:86` |
| **No rate limit on `POST /auth/request-link`** | Unauthenticated, writes to `users` on every call. Not an enumeration oracle — responses are identical — but it needs a per-address throttle before facing the internet — `apps/api/src/auth/auth.controller.ts:60` |
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

## 7. Where to start reading

If you want to understand this in one pass, in this order:

| Read | Why start here |
| --- | --- |
| `apps/api/src/full-journey.spec.ts` | Eight numbered tests that walk the whole product. The fastest way to see how the pieces connect |
| `apps/api/src/services/services.service.ts` | The post-change validation idea, which is the one non-obvious pattern in this batch |
| `apps/web/src/app/hub/page.tsx` | Why the landing page answers a question rather than showing a list |
| `apps/web/src/app/leads/[id]/page.tsx:104` | The quote block — the comment explains why a computed-but-unshown figure is rendered differently |
| `packages/shared-types/src/service-catalogue.ts` | One rules module, imported by both apps |

The journey test reads top to bottom as a story:

```
:137  1 — the owner builds a catalogue over HTTP
:152  2 — the first reply gets the numbered menu, built from that catalogue
:162  3 — "1" selects the service, with no model call
:175  4 — the remaining questions complete and the customer is quoted, GST-inclusive
:189  5 — the lead records exactly what the customer was told
:200  6 — the owner is texted a lead with a working login link
:226  7 — the owner opens the lead and marks it won
:246  8 — every message sent to the customer was billable-safe
```

---

## 8. Commits

Six, each standing alone:

| Commit | What |
| --- | --- |
| `bf745e5` | validate service pricing at save time, not at quote time |
| `667ce7a` | add the services module: an owner can finally build a catalogue |
| `0a84235` | add the leads API: inbox, detail, outcomes and the hub summary |
| `1a5415c` | **fix the magic link pointing at the dashboard instead of the API** |
| `32211c5` | add the dashboard |
| `8208a15` | add a whole-product test, and bring the docs up to date |

The magic-link fix has its own commit deliberately — it broke every lead SMS, the primary owner surface,
so it should be findable in the history rather than buried in a feature commit.

**One thing still outstanding, and it is yours:** delete the stale `NEXT_PUBLIC_API_URL` line from `.env`.
It is inert now (§4.2) but a misleading variable is a trap for whoever reads it next. Claude is blocked
from `.env` by `.claude/settings.json`, which is working as intended.
