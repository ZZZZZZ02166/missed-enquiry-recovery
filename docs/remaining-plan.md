# Remaining plan

Everything left to build, as of step 98. Written to be actionable: each task names its files, its
dependencies, the decisions it needs, and how you would know it is done.

Companion to `docs/codebase.md` (per-file, what exists) and `docs/build-report-92-98.md` (the auth run).

---

## 1. Where things actually stand

**Done and working end to end, with no human present:**

missed call → recovery SMS → numbered service menu → strict numeric selection → deterministic
GST-inclusive price → quote to the caller → structured lead → owner SMS with a **working single-use
login** → follow-up nudge → expiry → reconciliation sweeps.

That is the machine, and it is finished. 204 jest tests, ~900 checks across the scratchpad suites.

**Not done: almost every surface a human touches.**

| Surface | State |
| --- | --- |
| HTTP controllers | 4 — health, two Twilio webhooks, auth. **Zero owner-facing data routes** |
| Dashboard | 3 files, 46 lines. A scaffold |
| `services` module | 4 pure files. **No service class, no controller** — an owner cannot create a service |
| `businesses` module | 1 helper file. No CRUD |
| `leads` module | Service exists with `syncFromConversation` and `unnotified`. **No read or update API** |
| `conversations` module | State machine only. No read API |
| Tables | 11 of 12. `attachments` not started |

**The consequence worth stating plainly:** because no owner can create a service, every business today
hits `NO_CATALOGUE`, every caller gets the open-text question, and the entire menu-and-pricing chunk
(steps 80–91) is unreachable in production. Step 99 is what switches it on.

**Remaining: ~43–52 steps.** Backend 19–22, dashboard 20–24, deploy 4–6.

---

## 2. The two gates that are not code

Both are cheap, both are unresolved, and both change what is worth building.

### G1 — Carrier forwarding test · ~A$15, three SIMs, an afternoon

**This is a go/no-go on the entire architecture.** Everything above assumes a forwarded call arrives at
Twilio carrying the *original caller's* number. If Telstra, Optus or Vodafone present the forwarding
number instead, there is nobody to text and the product does not exist in its current form.

Procedure and results matrix: `docs/carrier-forwarding-test.md` (still empty). For each of the three
carriers, set all three conditions (`**61*`, `**67*`, `**62*`) and record whether `From` is the original
caller, what `ForwardedFrom` contains, whether declining fires CFB, and whether the forwarding leg was
billed.

**Every one of the ~50 remaining steps is built on this assumption.** It has been the stated week-0 gate
since the plan was written.

### G2 — A real model API key · ~1 hour

Extraction has never run against a real model. Every conversation test uses `FakeLlmProvider`, which
returns whatever the test scripts. The prompt, the JSON schema, the token budget and the cache behaviour
are all unverified against `claude-opus-5` or `gpt-5.6`.

Set `ANTHROPIC_API_KEY` and send five realistic Melbourne texts through
`ConversationsService.advance`. You are looking for: does it pull the suburb, does it read "2 bed 2
bath", does it ever try to quote, and what does a turn actually cost.

---

## 3. Backend — 19 to 22 steps

### 3.1 Services module — 3 steps · **the highest-value work left**

Unblocks the entire differentiator. Depends on: auth (done).

**Step 99 · `apps/api/src/services/services.service.ts`**

CRUD over the catalogue. `list`, `create`, `update`, `setAvailability`, `reorder`, `seedDefaults`.

Every mutation validates the **post-change** catalogue through `assertCatalogueValid`, not the incoming
row — validating one service in isolation cannot catch a duplicate name or a seventh active service,
because those are properties of the whole list.

Four decisions, with my recommendation:

| Decision | Recommendation | Why |
| --- | --- | --- |
| `sortOrder` on insert | `max(sortOrder) + 1` | Prisma defaults to `0`, which collides with the first service and trips `SORT_ORDER_DUPLICATE` immediately |
| Delete semantics | `DELETE` sets `DISABLED`; hard delete refused when leads reference it | `leads.serviceId` is `SetNull`, so history survives either way — but a hard delete loses the service name from every past lead's context |
| Defaults seeding | Explicit `seedDefaults`, called from onboarding | Auto-seeding on first read means a business that deliberately cleared its catalogue gets it back |
| Reorder shape | Whole-list `PUT` with an array of ids | The only shape that validates atomically, and a drag-and-drop UI sends the whole list anyway |

*Done when:* an owner's catalogue can be created, renamed, reordered, disabled and re-enabled; a seventh
active service is refused with a message naming the limit; a duplicate name differing only by case is
refused.

**Step 100 · `apps/api/src/services/services.controller.ts`**

`GET/POST/PATCH/DELETE /services`, `PUT /services/order`. Every route `@UseGuards(SessionGuard)` and
`@Session()`. DTOs with `class-validator`, `whitelist: true` already global so unknown fields are
stripped.

`CatalogueValidationError` maps to **422** with the issue array intact, so the dashboard can attach each
message to its row rather than showing one generic failure.

*Done when:* an HTTP spec proves business A cannot read, rename or delete business B's services.

**Step 101 · `apps/api/src/services/services.module.ts` + app wiring**

*Done when:* `app.boot.spec.ts` still constructs the graph and the menu appears for a business whose
catalogue was created entirely over HTTP.

### 3.2 Leads API — 3 steps

The owner's actual destination when they tap the SMS link. Depends on: auth.

**Step 102 · read methods on `LeadsService`** — `list(businessId, filters)` and `get(businessId, id)`.
Filters: status, needsHuman, date range. Paginated by cursor, not offset — an inbox grows and `OFFSET`
degrades.

**Step 103 · `leads.controller.ts`** — `GET /leads`, `GET /leads/:id`.

Return **404 for another tenant's lead, never 403.** A 403 confirms the id exists, which is an
enumeration oracle across tenants; the plan's verification list calls this out specifically.

**Step 104 · status updates** — `PATCH /leads/:id` for `WON` / `LOST` / `wonValueCents` / `needsHuman`.

`nextLeadStatus` already refuses to regress past an owner-set outcome; this is the first thing that
actually sets one. Writes `closedAt`.

*Done when:* the magic link in a lead SMS lands on a lead the owner can read and mark Won with a value —
which is the metric the whole renewal conversation depends on.

### 3.3 Businesses settings — 2 steps · deferrable

`GET/PATCH /business` for `timezone`, `hours`, `pricesIncludeGst`, `notifyPhoneE164`, `automationConfig`.

**Deferrable for a pilot** because three businesses can be configured with direct SQL. It stops being
deferrable the moment there is a fourth.

Watch: changing `pricesIncludeGst` retroactively changes what every *future* quote says while leaving
`quoteSnapshot` on past leads intact. That is correct, and it will look like a bug to whoever notices.

### 3.4 Conversations API — 2 steps · deferrable

`GET /conversations/:id` returning the message thread, and `POST /conversations/:id/reply` for a manual
owner reply.

The manual reply is the interesting half: it must go through the same reserve-send-confirm path as
`InboundMessageProcessor.reply`, or it becomes a second, untested way to send an SMS that skips the send
cap, the suppression check and the GSM-7 assertion.

### 3.5 Attachments — 4 steps · deferrable

The 12th table and the last piece of the MVP scope as originally written.

| Step | File | Note |
| --- | --- | --- |
| 105 | `schema.prisma` | `attachments` + migration |
| 106 | `attachments.service.ts` | Tokenised single-use upload links, same crypto shape as magic links |
| 107 | `attachments.controller.ts` + S3/R2 adapter | Public unauthenticated upload endpoint — **content-type and size limits are the whole security surface** |
| 108 | Conversation wiring | Send the upload link when the service config asks for photos |

**No MMS, ever** (rule 4): US$0.35 each way and unreliable in AU.

### 3.6 Ops — 1 to 2 steps

- **Global kill switch.** `SENDING_ENABLED` is read by `SendCapService`; there is no way to flip it
  without a redeploy. A `businesses.sendingEnabled` column plus an admin route would make it per-tenant
  and immediate.
- **Sentry.** In the stack list, not installed. Wire `main.ts` and `worker.ts`, scrub phone numbers and
  message bodies before send — a crash report full of customer PII is its own incident.

---

## 4. Dashboard — 20 to 24 steps

Currently 46 lines. Depends on: the API steps above; `shared-types` is already wired into `apps/web`.

| # | Piece | Steps | Notes |
| --- | --- | ---: | --- |
| 1 | API client + session handling | 2 | `credentials: 'include'`, 401 → sign-in redirect. One place, or every call re-invents it |
| 2 | Magic-link landing + `/auth/expired` | 2 | The cookie is set by the API redirect; the page only reads `/auth/me`. **Part 7 gotcha 4** — same registrable domain or lose a day to Safari ITP |
| 3 | Shell, nav, layout | 1 | |
| 4 | Lead inbox | 2 | Cursor pagination, status filter |
| 5 | Lead detail + Won/Lost | 3 | The screen the SMS link opens. Must render `quoteShownToCustomer: false` **without showing the figure as if the customer saw it** |
| 6 | **Services settings** | 4–5 | The biggest piece — see below |
| 7 | Business settings | 2 | Pairs with 3.3 |
| 8 | Conversation thread + manual reply | 2 | Pairs with 3.4 |
| 9 | Photo upload page | 2 | Public, unauthenticated, single-use token |
| 10 | Styling and polish | 2 | |

**Why services settings is disproportionate.** It is the only screen where an owner creates something
the conversation engine then depends on. Every rule in `shared-types/service-catalogue.ts` needs an
affordance and an error state: four pricing types with different fields, live name validation, the
currency-in-a-name rejection explained rather than just refused, the six-active limit as a *blocking*
error with a way to disable the surplus, drag-and-drop reorder, and required-fields selection.

Get it wrong and an owner either cannot save, or saves something that produces a bad quote. It deserves
the extra steps.

---

## 5. Deploy and CI — 4 to 6 steps

| Step | What | Watch |
| --- | --- | --- |
| Dockerfile | One image, two commands (`main.js` / `worker.js`) | The D7 decision is that these share an image. Do not split it |
| CI pipeline | `typecheck`, `lint`, `test`, `build` on every push | The currency guard and every GSM-7 module-load assertion only protect you if CI runs |
| Production env | Real `SESSION_SECRET`, Twilio creds, `SESSION_COOKIE_DOMAIN`, model key | `.env.example` is the checklist |
| Redis persistence | `appendonly=yes`, `maxmemory-policy=noeviction` | **Part 7 gotcha 3.** A "cache" Redis silently drops every delayed job on restart, killing all follow-ups |
| Domains | `app.` + `api.` under one registrable domain | D9. Getting this wrong breaks cookies in Safari specifically |

---

## 6. Explicitly not doing

Recorded so nobody re-adds them by accident. Full reasoning in `docs/decisions.md` and the plan's Part 3.

| Cut | Why | Comes back |
| --- | --- | --- |
| Stripe / billing | Invoice three pilots by bank transfer | ~8–10 steps, after 3 paying pilots |
| `appointments` + booking | The owner books in whatever they already use | Phase 2 / ServiceM8 |
| Staff invitations, RBAC | Pilot businesses have 1–3 people. **Tenancy stays; roles do not** | When a customer forces it |
| Separate analytics module | Six SQL queries behind one endpoint | When it is slow |
| `automation_rules` table | JSONB on `businesses` | When a customer forces it |
| Four-tier commercial pricing | Pricing tiers before pricing evidence is theatre | After 3 pilots |
| `MATRIX` pricing type | Schema already accepts it additively (`services.pricingRules`) | Built from real pilot override data |

---

## 7. Debt carried forward

Each is flagged in the code as well as here.

| Debt | Risk | Where |
| --- | --- | --- |
| `POST /auth/request-link` has **no rate limit** | Unauthenticated, writes to `users` per call. Not an enumeration oracle — responses are identical — but needs a per-address throttle before facing the internet | `auth.controller.ts` |
| No email transport | `request-link` mints and logs at debug rather than sending. The SMS path is the real one, so this does not block a pilot | `auth.controller.ts` |
| Owner SMS budget **exactly full** | 413 of 459 chars, 3/3 segments. Any new field pushes a worst-case lead to four. Fix is a short `/l/<token>` route (≈90 chars back), *not* raising `MAX_OWNER_SEGMENTS` | `templates.ts` |
| Partial index missing | `magic_link_token_hash` is null for nearly every row. Fine at pilot scale; Prisma cannot express a partial index, so it would be hand-written SQL | `schema.prisma` |
| One user per business assumed | The notifier picks the oldest user | `notify-owner.processor.ts` |
| `isSpam`, `isDuplicate`, `propertyCondition`, `costCents` have **no writer** | `costCents` is the one that matters: margin per message is not computable without it, and that is a pilot metric | `schema.prisma` |
| `conversations.completedAt` overwritten | Means "last completed", not "first". Nothing reads it yet | `inbound-message.processor.ts` |
| Reconciler thresholds are guesses | 15-minute orphan sweep, 2-minute staleness — wall-clock guesses, never measured against real traffic | `inbound-reconciler.processor.ts` |
| Matcher thresholds are guesses | `MIN_CONFIDENCE`, `AMBIGUITY_MARGIN`, `MIN_TEXT_COVERAGE` tuned against invented cases. Log every `no_match` and `ambiguous` with the caller's text during the pilot | `service-matcher.ts` |
| Node and Postgres are patched locally | Node 24 in `.tools/node`, Postgres on 5433 — both worked around a `brew upgrade`. Production should pin Node 24 properly | `CLAUDE.md` |

---

## 8. Critical path

```
G1 carrier test ──────────────────────────────► (gates everything)

auth ✔ ──► services module ──► services UI ──┐
                    │                         ├──► pilot
                    └──► leads API ──► lead UI ┘

G2 model key ──► prompt tuning ───────────────► (gates quote quality)
```

**Nothing in the dashboard can start before its API exists** — an API client with no endpoints is a
guess about response shapes that will be wrong.

**Services before leads.** Leads are readable without services; they are just not *interesting* without
them, because no lead carries a quote until a catalogue exists.

---

## 9. Pilot-minimum

The smallest thing three paying cleaning businesses can actually use. **~26–31 steps.**

| Include | Steps |
| --- | ---: |
| Services module + controller + wiring | 3 |
| Leads API — read, detail, Won/Lost | 3 |
| API client + session handling | 2 |
| Magic-link landing | 2 |
| Lead inbox + detail + Won/Lost | 5 |
| Services settings UI | 4–5 |
| Shell and minimal styling | 2 |
| Deploy, CI, env, Redis persistence | 4–5 |
| **Total** | **25–27** |

Deferred without hurting the pilot: attachments (4), conversation thread and manual reply (2+2),
business settings (2+2), polish (2). I would configure three pilot businesses by direct SQL rather than
build a settings screen for three rows.

**Do G1 first.** A failed carrier test invalidates the architecture, and it costs an afternoon against
25 steps of work built on top of it.
