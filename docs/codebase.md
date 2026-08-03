# Codebase — what every file does, and why

A learning document, not an API reference. The **why** matters more than the what: anything you could
work out by reading the file in thirty seconds doesn't need to be here, but the reasoning behind a
choice — and the alternative that was rejected — disappears from memory within a week.

**Every file in this repo gets an entry, written at the same time as the file**, so the two can't drift
apart.

### How to read it

- **Build log** — every step in order. Use it to retrace how the project was assembled.
- **File reference** — the detail, grouped by area (Root · Docs · Claude config · Infra · API · Web ·
  Shared). Sections appear as files land; empty ones aren't listed.

Each entry follows the same four headings:

| Heading                       | Answers                                   |
| ----------------------------- | ----------------------------------------- |
| **What it does**              | Its one responsibility, in plain language |
| **Why it's written this way** | The reasoning, and what was rejected      |
| **Connects to**               | What it depends on and what depends on it |
| **Watch out for**             | The thing that will bite someone later    |

### Boundary with `docs/decisions.md`

This file explains **files**. `docs/decisions.md` records **choices that span files** — no voicemail,
four pricing types, SMS-first owner surface. When a file embodies a decision, its entry links to the
decision rather than restating the argument.

---

## Build log

| #   | Date       | File                                                    | In one line                                                                         |
| --- | ---------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | 2026-07-27 | `CLAUDE.md`                                             | Project brief, build protocol, and the 12 engineering invariants                    |
| 2   | 2026-07-27 | `docs/codebase.md`                                      | This file — the running per-file explanation                                        |
| 3   | 2026-07-27 | `.claude/skills/twilio/SKILL.md`                        | Telephony reference: webhooks, Lookup, opt-out, SMS segments, testing               |
| —   | 2026-07-27 | `CLAUDE.md`                                             | Amended rule 7 — signatures validate over URL + sorted params, not raw body         |
| 4   | 2026-07-27 | `.claude/skills/queues-redis/SKILL.md`                  | BullMQ and Redis: persistence, idempotency, retries, delayed work                   |
| 5   | 2026-07-27 | `.claude/skills/backend/SKILL.md`                       | NestJS + Prisma: tenancy assertion, modules, auth, migrations, money                |
| 6   | 2026-07-27 | `.claude/skills/frontend/SKILL.md`                      | Next.js dashboard: cookie domain, magic link, mobile-first, en-AU formatting        |
| 7   | 2026-07-27 | `docs/decisions.md`                                     | ADR-lite: 12 locked decisions with rejected alternatives, 5 pending                 |
| 8   | 2026-07-27 | `docs/carrier-forwarding-test.md`                       | The go/no-go gate — protocol and empty results matrix                               |
| 9   | 2026-07-27 | `docs/twilio-setup.md`                                  | Account runbook: bundle, geo permissions, numbers, webhooks, usage triggers         |
| 10  | 2026-07-27 | `docs/compliance.md`                                    | Spam Act position, sender split, privacy posture, price representations, retention  |
| 11  | 2026-07-27 | `.claude/settings.json`                                 | Permission allowlist, and denies for the destructive Prisma commands                |
| 12  | 2026-07-27 | `pnpm-workspace.yaml`                                   | Monorepo shape, and the pnpm build-script allowlist Prisma needs                    |
| 13  | 2026-07-27 | Scaffolding batch                                       | Root config, both apps, Prisma + first migration, health, phone helper — see below  |
| 14  | 2026-07-27 | `apps/api/src/prisma/tenant-guard.ts`                   | D8 — throws when a query on a tenant model isn't scoped by businessId               |
| 15  | 2026-07-27 | `apps/api/src/prisma/tenant-guard.spec.ts`              | 71 tests pinning the guard's behaviour, including the OR trap                       |
| 16  | 2026-07-29 | `apps/api/src/prisma/prisma.service.ts`                 | Applies the guard; three surfaces — `db`, `unscoped`, raw                           |
| 17  | 2026-07-29 | `apps/api/prisma/schema.prisma`                         | `phone_numbers` — first tenant model; guard proven 8/8 against a live database      |
| 18  | 2026-07-29 | `apps/api/prisma/schema.prisma`                         | `webhook_events` — idempotency backbone, keyed on a handler-built `dedupeKey`       |
| 19  | 2026-07-29 | `.claude/skills/twilio/SKILL.md`                        | Corrected §3 — `CallSid` alone is not a valid uniqueness key                        |
| 20  | 2026-07-29 | `apps/api/src/telephony/twilio-signature.guard.ts`      | Rejects forged webhooks; URL pinned to PUBLIC_API_URL. 11/11 verified               |
| 21  | 2026-07-29 | `apps/api/src/telephony/twilio-signature.guard.spec.ts` | 24 tests: forgery, replay, diagnostics, unconfigured token                          |
| 22  | 2026-07-29 | `apps/api/src/telephony/webhook-events.service.ts`      | Idempotent recording; 5 deliveries for one CallSid → 3 rows                         |
| 23  | 2026-07-29 | `apps/api/src/telephony/webhook-events.service.spec.ts` | First integration suite — real Postgres, incl. a concurrency race                   |
| —   | 2026-07-29 | `apps/api/package.json`                                 | `NODE_OPTIONS=--experimental-vm-modules` — Prisma 7 needs it under Jest             |
| 24  | 2026-07-31 | `apps/api/src/telephony/voice.controller.ts`            | Answers the forwarded call; resolves tenant from `To`. 15/15 verified               |
| 25  | 2026-07-31 | `apps/api/src/telephony/telephony.module.ts`            | Wires the controller, guard and service; routes map, guard rejects unsigned         |
| 26  | 2026-07-31 | `apps/api/src/app.module.ts`                            | Imports TelephonyModule — routes go live; signed curl → TwiML, end to end           |
| 27  | 2026-08-01 | `apps/api/prisma/schema.prisma`                         | `customers` + `calls` — a call is not a lead (D5). 14/14 verified                   |
| 28  | 2026-08-01 | `apps/api/src/calls/calls.service.ts`                   | Records the call and decides whether to recover. 18/18 verified                     |
| 29  | 2026-08-01 | `apps/api/prisma/schema.prisma`                         | `suppressions` — opt-out, blocklist, landline cache in one table. 9/9 verified      |
| 30  | 2026-08-01 | `apps/api/src/calls/suppressions.service.ts`            | "May we send?" + OPTED_OUT-wins precedence + STOP keywords. 15/15 verified          |
| 31  | 2026-08-01 | `apps/api/src/calls/calls.service.ts`                   | Wires the suppression check — Spam Act gap CLOSED. Found a bug in step 30           |
| 32  | 2026-08-01 | `apps/api/prisma/schema.prisma`                         | `optedOutAt` splits the legal fact from the operational one. **Build red until 33** |
| 33  | 2026-08-01 | `apps/api/src/calls/suppressions.service.ts`            | Rewritten for the two-column model — step 31 bug fixed. Green. 18/18                |
| 34  | 2026-08-01 | `apps/api/src/calls/calls.module.ts`                    | Wires calls + suppressions. Found: **tsx breaks Nest DI**, `dev:worker` affected    |
| 35  | 2026-08-02 | `apps/api/package.json`                                 | `dev:worker` moved off tsx to `nest start --entryFile worker` — DI now works        |
| 36  | 2026-08-02 | `apps/api/src/telephony/telephony.module.ts`            | Imports CallsModule — `CallsService` now reachable from the webhook. 7/7            |
| —   | 2026-08-02 | `apps/api/src/telephony/telephony.module.ts`            | Merged the duplicate doc block left by step 36 (cosmetic)                           |
| 37  | 2026-08-02 | `apps/api/src/telephony/voice.controller.ts`            | **Loop closed** — a signed webhook now creates a Call + decision. 7/7 end to end    |
| 38  | 2026-08-02 | `apps/api/src/jobs/queues.ts`                           | Queue topology, payloads, Redis durability check. 13/13 verified                    |
| —   | 2026-08-02 | `.claude/skills/queues-redis/SKILL.md`                  | Corrected `jobId` guidance — BullMQ rejects `:` in a custom id                      |
| 39  | 2026-08-02 | `apps/api/src/jobs/jobs.module.ts`                      | Queues as injectable providers; durability check now runs at boot. 8/8              |
| 40  | 2026-08-02 | `apps/api/src/common/gsm7.ts`                           | GSM-7 charset + segment counting — rule 5 becomes enforceable. 30/30                |
| 41  | 2026-08-02 | `apps/api/src/notifications/templates.ts`               | The recovery SMS copy; rules 2, 5, 10 asserted at import. 18/18                     |
| 42  | 2026-08-02 | `apps/api/src/telephony/sms.provider.ts`                | `SmsProvider` seam + `FakeSmsProvider` — telephony testable without a phone. 16/16  |
| 43  | 2026-08-02 | `apps/api/src/businesses/business-name.ts`              | Rejects unsendable names at input — fixes a lead-losing flaw found in review. 21/21 |
| 44  | 2026-08-02 | `apps/api/src/notifications/templates.ts`               | Send path degrades instead of throwing — lead-losing path CLOSED. 15/15             |
| 45  | 2026-08-02 | `apps/api/src/telephony/twilio-sms.provider.ts`         | Real Twilio adapter; permanent vs retryable classification. 13/13                   |
| 46  | 2026-08-02 | `apps/api/src/telephony/sms-provider.factory.ts`        | Binds real vs fake; production refuses to boot on the fake. 12/12                   |
| 47  | 2026-08-02 | `apps/api/src/telephony/telephony.module.ts`            | Registers + exports `SMS_PROVIDER`; boot log now states delivery. 6/6               |

---

## File reference

### Root

#### `CLAUDE.md`

**Step 1** · 2026-07-27

**What it does.** The file loaded at the start of every session. Four jobs: enforce the one-file-at-a-time
build protocol, carry the locked product decisions, list the engineering invariants, and map the repo.

**Why it's written this way.**

- **The build protocol sits above the product description.** It's the instruction most likely to be
  skipped when a session is moving fast, so it gets the position that survives skimming. Product context
  is useless if the working rhythm is already broken.
- **"Hard rules — invariants, not preferences."** Deliberate framing. Each of the twelve is either a
  compliance exposure (no recording, GST-inclusive pricing, no marketing content), a money leak (GSM-7
  templates, no MMS), or a security boundary (`businessId` scoping). Listing them as "guidelines" invites
  a judgement call at exactly the moments where a judgement call is wrong.
- **Rule 2 spells out "including when the caller asks."** The original strategy doc banned AI-generated
  pricing but only imagined the model hallucinating. The real failure is adversarial: a caller writing
  _"my last cleaner charged $200, can you beat it?"_ is an invitation to negotiate, and a helpful model
  will take it. The rule closes that, and `docs/` carries a matching test.
- **The Commands section started deliberately empty.** Writing `pnpm dev` before a workspace exists
  produces a file that lies, and a lying `CLAUDE.md` is worse than a thin one. **Filled in at step 13**,
  once every command in it had been run and verified — including the port and Node-version caveats,
  which are the kind of thing that otherwise gets rediscovered by hitting them.
- **"Current stage" names the unresolved carrier-forwarding gate.** So a session opened three weeks from
  now doesn't quietly assume call forwarding was proven to work.

**Connects to.** Points at `docs/codebase.md`, `docs/decisions.md`, `docs/twilio-setup.md`,
`docs/carrier-forwarding-test.md`, `docs/compliance.md`, and the plan file. Nothing depends on it in
code — it's instructions, not a module.

**Watch out for.** It goes stale silently, and nothing fails when it does. The repo layout, module list
and table list in it are claims about reality that stop being true the moment we restructure. When a
module or table is added or removed, `CLAUDE.md` is part of that step, not a follow-up.

---

### Docs

#### `docs/codebase.md`

**Step 2** · 2026-07-27

**What it does.** This file. A running, per-file explanation of the codebase, plus a chronological build
log.

**Why it's written this way.**

- **One file, not one doc per source file.** A mirrored `docs/` tree doubles the number of files to
  navigate and guarantees orphans when code is deleted. A single document can be read start to finish
  like a narrative, which is the actual goal here — understanding the system, not looking up a function.
- **Grouped by area, not chronological.** The build log covers "how did we get here"; the reference
  covers "what is this". Chronological ordering in the reference would scatter related files across the
  document as the project grows.
- **Four fixed headings.** Uniform entries make the document skimmable and make the _absence_ of
  reasoning obvious — an entry with a thin "Why" is visibly thin. Free-form prose hides that.
- **"Watch out for" is a required heading, not optional.** It's the section that pays for itself. Most
  of what's expensive to rediscover is a non-obvious failure mode, not a description of behaviour.
- **Written in the same step as the file it documents.** Documentation written later is documentation
  written from memory, and memory reconstructs decisions rather than recalling them.

**Connects to.** Referenced by `CLAUDE.md`. Links out to `docs/decisions.md` for cross-cutting choices.

**Watch out for.** It grows monotonically. Past roughly 1,500 lines, split the **File reference** into
per-area files (`docs/code/api.md`, `docs/code/web.md`) and keep the build log and conventions here.
Split on size, not before — premature splitting costs navigability for no gain.

Also: when a file is **deleted**, its entry moves to a `## Removed` section at the bottom with the date
and reason. Don't delete the entry. Knowing why something was removed is worth more than knowing it
once existed.

---

### Claude config

#### `.claude/skills/twilio/SKILL.md`

**Step 3** · 2026-07-27

**What it does.** On-demand reference for everything Twilio in this product: the answer-and-hang-up voice
flow, webhook signature validation, the validate→persist→enqueue→return contract, Lookup before first
send, opt-out and error 21610, SMS copy and segment rules, AU specifics, testing without a phone, and
cost circuit breakers.

**Why it's written this way.**

- **A skill, not a section of `CLAUDE.md`.** Skills load on demand from their `description`, so these
  ~200 lines surface when telephony code is being written and stay out of context the rest of the time.
  `CLAUDE.md` is loaded every session, so it only carries the one-line invariants; the reasoning lives
  here.
- **The description is written for matching, not for humans.** It names the concrete triggers —
  `telephony/`, message template, webhook, buying a number, debugging a failed SMS or signature failure
  — because a vague description means the skill doesn't load when it's needed, which is the only way a
  skill fails.
- **Signature validation leads with URL reconstruction, not the body.** This corrects an assumption from
  the plan (see _Watch out for_). Behind a proxy the reconstructed URL is `http` while Twilio called
  `https`, so every signature fails with no useful error. It is by far the most common cause of this bug
  and deserved the top of the section.
- **Error codes are a table, with 21408 first and a note on 30007.** 21408 (geo permissions) looks
  exactly like a code bug on a fresh account and can burn a day. 30007 (carrier filtering) is silent
  from the sender's side and is an _operational_ argument for keeping messages transactional — worth
  connecting to the legal argument rather than leaving in a list.
- **§8 mandates the `TelephonyProvider` interface from the first commit.** Retrofitting a seam after the
  SDK is called from six places is expensive, and until it exists every integration test costs money and
  needs a handset.
- **Circuit breakers are in the telephony skill, not an ops doc.** They're enforced at the send call
  site, so they belong where someone is writing a send.

**Connects to.** `docs/twilio-setup.md` (account and regulatory bundle),
`docs/carrier-forwarding-test.md` (the `From` assumption this whole flow rests on),
`docs/compliance.md` (opt-out, message content). Governs everything under `apps/api/src/telephony/`.

**Watch out for.** This file corrected `CLAUDE.md` rule 7, which originally said Twilio "signs the raw
request body." That holds only for payloads delivered as JSON with a `bodySHA256` query param. Standard
voice and messaging webhooks are form-encoded, and Twilio signs _URL + alphabetically sorted params_ —
so the parsed body is what's needed, and the **URL** is what usually breaks. `rawBody: true` stays
(JSON case, Stripe later), but the reasoning was wrong. **Amended in step 3.**

Second: the `From` parameter is assumed to be the original caller. **That assumption is unverified** and
is the go/no-go gate for the product. If AU carriers present the forwarding party instead, §1 of this
skill and the architecture both change.

**Amended at step 19 — §3 rewritten.** The original text specified a unique constraint on
`(provider, externalEventId)` and called `CallSid` an idempotency key. That is wrong in a way that loses
data silently: one call emits an incoming webhook plus several status callbacks sharing a `CallSid`, so
the constraint would accept the first and reject the rest — the call would never appear to complete, and
nothing would error.

§3 now specifies a handler-constructed `dedupeKey` with a table of the four shapes, states the rule
(_the key must include every field that distinguishes one legitimate delivery from another_), and
requires each handler to carry a test asserting two distinct deliveries produce two rows. Also added:
why storing each status as its own row makes true ordering recoverable, given callbacks arrive out of
order.

**Why this was worth its own step.** The skill is what loads when a future session writes telephony
code. `schema.prisma` had already been corrected, but a stale skill would have actively instructed
someone to reimplement the collision against a schema that no longer matched — worse than no guidance,
because it reads as authoritative.

#### `.claude/skills/queues-redis/SKILL.md`

**Step 4** · 2026-07-27

**What it does.** On-demand reference for BullMQ and Redis: the Redis settings that destroy scheduled
work, queue topology, idempotent processors, retry policy, delayed and repeatable jobs, rate limiting,
failure handling, graceful shutdown, and testing.

**Why it's written this way.**

- **Redis configuration leads, ahead of any BullMQ API.** Two settings — `appendonly yes` and
  `maxmemory-policy noeviction` — cause failures that produce _no error at all_. A non-persistent Redis
  drops every delayed job on restart; `allkeys-lru` evicts job data under memory pressure. Both look
  like "the follow-ups just didn't send." Everything else in the file is recoverable by reading a stack
  trace; these two aren't, so they go first.
- **"`jobId` is not enough" is its own section.** The natural assumption is that BullMQ's `jobId`
  provides idempotency. It only deduplicates while the job is _in_ the queue — once completed and
  removed, the same id runs again. Durable idempotency has to live in Postgres. Left implicit, this
  produces duplicate SMS to real customers.
- **The retry table lists what must _not_ retry.** Twilio 21610 and 21614 fail identically every time;
  retrying five times with exponential backoff turns one wasted send into five and buries the real cause.
  21408 is separated out because it's a configuration bug that should alert, not retry.
- **Timezone appears in the delayed-jobs section, not only in `CLAUDE.md` rule 12.** The rule is abstract;
  the consequence is a nudge SMS arriving at 3am. Repeating it at the point of use is worth the
  duplication.
- **§9 mandates a Redis-restart test.** It's the only way to prove the persistence config in §1 is
  actually applied. The alternative is discovering it in production after a week of nudges silently
  didn't fire — and nothing in the app would have reported a problem.
- **Real Redis in integration tests, not a fake.** In-memory fakes diverge from real behaviour on delayed
  sets, stalled-job detection and atomicity — which are precisely the behaviours worth testing here.

**Connects to.** The `twilio` skill (§3 webhook contract produces these jobs; error codes drive the
no-retry table). Will govern `apps/api/src/jobs/` and `worker.ts`. `docker-compose.yml` must set the
persistence and eviction options in §1.

**Watch out for.** Repeatable jobs persist **in Redis**, not in code. Changing a cron pattern leaves the
old schedule running — you get both until the old repeatable job is explicitly removed on deploy. This
is the one thing here that fails quietly in the opposite direction: too much work rather than none.

Also: the stalled-job mechanism re-runs a job _while the first run is still in progress_ if a processor
blocks the event loop. Idempotent processors (§3) are what make that survivable rather than a
double-charge.

#### `.claude/skills/backend/SKILL.md`

**Step 5** · 2026-07-27

**What it does.** On-demand reference for the NestJS + Prisma API: multi-tenant scoping, module layout,
magic-link auth, Prisma schema and migration conventions, phone normalisation, money handling, error
handling, the two entrypoints, and testing.

**Why it's written this way.**

- **Tenancy is §1 and takes a quarter of the file.** It's the only bug class in this product that is a
  genuine incident rather than an inconvenience — one business reading another's customer list. Length
  here is proportional to consequence, not to complexity.
- **Assert the scope; don't auto-inject it.** The obvious design is a Prisma extension that quietly adds
  `where: { businessId }` everywhere. Rejected for two reasons. It _hides_ missing scoping rather than
  surfacing it, so the day someone writes a query the extension doesn't cover, it fails open. And it
  can't work at all for Twilio webhooks or job processors, where the tenant comes from a phone-number
  lookup or `job.data` rather than a session — auto-injection from an empty session would silently scope
  to nothing. Asserting turns an unscoped query into a loud runtime error and works identically in all
  three contexts.
- **`forbidNonWhitelisted: true`, not just `whitelist: true`.** Whitelisting alone silently strips an
  injected `businessId`; forbidding makes the attempt a 400. Same protection, but the loud version tells
  you someone tried.
- **404 rather than 403 for cross-tenant access.** A 403 confirms the record exists, which is itself a
  leak — it lets an attacker enumerate valid ids across tenants.
- **"Never mock Prisma."** Mocked query builders assert the _shape_ of a call rather than that the query
  is correct, so they pass while the SQL is wrong. That failure mode is especially bad here, because the
  thing most worth testing is exactly the `where` clause.
- **Services take `businessId` explicitly even though the assertion extension exists.** Belt and braces
  is justified when the value arrives from three different sources; ambient context is where the
  confusion would come from.
- **Magic-link tokens are hashed at rest and single-use.** They're bearer credentials delivered over SMS
  — treat them like passwords, and consume them in the same transaction that issues the session so a
  replayed link can't mint a second one.

**Connects to.** The `frontend` skill (session cookie domain — the API and dashboard must share a
registrable domain). The `twilio` skill (`trust proxy` in `main.ts` is what makes signature validation
work; webhook tenant resolution is the main `unscoped()` caller). The `queues-redis` skill (`worker.ts`
uses `createApplicationContext`, and processors receive `businessId` in `job.data`).

**Watch out for.** `prisma.unscoped()` is a deliberate hole in the tenancy guarantee. It's needed —
resolving a webhook's `To` number and looking up a magic-link token both happen before a tenant is
known — but every call site must stay greppable and few. A growing list of `unscoped()` calls is the
signal that the assertion is being worked around rather than satisfied.

Second: `db push` drops columns without asking. It's the fastest way to lose pilot data, and it's one
key away from `migrate dev` in muscle memory.

#### `.claude/skills/frontend/SKILL.md`

**Step 6** · 2026-07-27

**What it does.** On-demand reference for the Next.js dashboard: the cookie domain requirement, the
Next↔Nest boundary, the magic-link exchange, the MVP screens, mobile-first layout rules, en-AU
formatting, env/secret discipline, and Playwright coverage.

**Why it's written this way.**

- **It opens by naming the user, not the framework.** An owner outdoors, one-handed, arriving from an
  SMS, gone in a minute. Nearly every layout and priority decision downstream follows from that, and a
  conventions file that opens with folder structure produces a desktop-shaped dashboard by default.
- **The cookie domain requirement is §1, above all technical content**, because it's the one thing that
  cannot be fixed cheaply later — changing it after the pilot means reissuing every session. It also
  corrects the distinction people actually get wrong: **same-site is not same-origin.**
  `app.yourdomain.com` → `api.yourdomain.com` is cross-origin but _same-site_, so `SameSite=Lax` cookies
  are sent. It's `vercel.app` + `railway.app` — two different registrable domains — that forces
  `SameSite=None`, which Safari's ITP blocks. The failure mode is the nasty kind: auth works on the
  developer's laptop and fails for a customer on an iPhone.
- **"Next.js never touches the database" is stated as a rule, not a preference.** With a NestJS API
  already holding the tenancy assertion and the pricing logic, a second data path through Server Actions
  would mean a second place for authorization to be wrong. Server Components fetch; mutations go to the
  API.
- **Tap-to-call is specified as the primary action on the lead page**, above the message thread. The
  fastest route to winning the job is the owner's voice on the phone within a minute — not a
  well-designed reply box. Ranking the actions here prevents a later "improvement" from burying it.
- **One-tap Won/Lost is justified in-file rather than assumed.** It's the only source of the ROI numbers
  the renewal conversation depends on, and every extra field on that control costs completion. The
  reasoning has to travel with the control or someone will add a notes field to it.
- **Playwright runs at mobile viewport by default.** A suite that only passes at 1280px is testing a
  screen nobody in this market uses.

**Connects to.** The `backend` skill (§3 issues the session cookie and the magic-link token this
consumes; the cookie `Domain` must match on both sides). `apps/web/` in full. The tenancy Playwright
check is the browser-side counterpart to the backend's 404-not-403 rule.

**Watch out for.** `NEXT_PUBLIC_*` is shipped to the browser. Only the API base URL belongs there — the
dashboard authenticates as a user via cookie and holds no service credentials of its own. A Twilio token
placed behind that prefix is published to every visitor.

Second: `cache: 'no-store'` on lead fetches is deliberate. Next's default caching will happily serve one
business a stale render, and the fix is unobvious when it happens.

#### `docs/decisions.md`

**Step 7** · 2026-07-27

**What it does.** ADR-lite log of choices that span files. Twelve locked decisions (D1–D12) and five
pending (D13–D17), each with what was chosen, what was rejected, and what it costs.

**Why it's written this way.**

- **Every entry records the rejected alternative, not just the choice.** This is the whole point of the
  file. A decision without its rejected alternative gets re-proposed within a month, and the reasoning
  has to be rebuilt from nothing. "We use conditional forwarding" is much less useful than "we rejected
  issuing a new number because no business will change what's painted on their van."
- **Every entry records a cost.** A decision log that only lists benefits is marketing. Naming the cost
  (D2 destroys their voicemail; D3 adds two weeks; D6 spends a segment per lead) is what makes it
  possible to revisit honestly later.
- **Four statuses, including `Provisional` and `Pending`.** Not everything is settled, and pretending
  otherwise is how a pending question quietly becomes an assumption. D13 — do AU carriers preserve the
  caller's number — is explicitly open, with the test that resolves it.
- **Pending items name their resolving test, not a date.** "Revisit in Q4" is how open questions die.
  "Resolved by `docs/carrier-forwarding-test.md`" is actionable.

**Connects to.** Referenced by `docs/codebase.md` (the boundary: files here, cross-cutting choices
there), `CLAUDE.md` (locked decisions table summarises D1, D2, D3, D5, D6), and every skill file that
implements one of these decisions.

**Watch out for.** D13 is the load-bearing pending item. D1, D2 and most of the product depend on an
answer nobody has measured yet. Until `docs/carrier-forwarding-test.md` is filled in, treat the
architecture as provisional regardless of how settled the locked entries read.

---

### Docs (operational)

#### `docs/carrier-forwarding-test.md`

**Step 8** · 2026-07-27

**What it does.** The week-0 go/no-go protocol: what to buy, the Twilio Function that captures webhook
parameters, the GSM forwarding codes, a nine-row results matrix (three carriers × three conditions), and
what each outcome means.

**Why it's written this way.**

- **Marked "NOT RUN" at the top in bold.** The file's most important property is that its emptiness is
  visible. A blank results table halfway down a document reads as an oversight; a status line at the top
  reads as a gate.
- **The decision tree is written _before_ the results exist.** Deciding what "only two carriers work"
  means while staring at a disappointing result invites rationalisation. Three named outcomes with
  pre-committed responses — including "stop and redesign" with three ranked alternatives — removes that.
- **Nine rows, not three.** Conditional forwarding is three separate GSM settings. Testing only
  no-reply would miss that declining a call fires busy (`**67*`), and declined calls are a large share of
  real misses — a tradie glancing at a ringing phone with wet hands.
- **Includes the billing check.** The _business_ is charged for the forwarding leg. It's usually $0 on
  unlimited plans, but "usually" isn't good enough when the failure is an owner getting an unexpected
  phone bill because of us. Cheapest to check while the SIMs are already out.
- **Recommends a Twilio Function over a TwiML Bin.** A Bin returns static TwiML and can't log the
  inbound parameters — which are the entire point of the test.

**Connects to.** D1 and D13 in `docs/decisions.md`. §1 of the `twilio` skill assumes this test passes.

**Watch out for.** The no-reply timer (`*11*20#`) is not honoured by every carrier. If it's ignored, the
caller waits the carrier default before hearing our greeting, which changes the perceived speed of the
whole product.

#### `docs/twilio-setup.md`

**Step 9** · 2026-07-27

**What it does.** Console and account runbook: trial upgrade, geo permissions, the AU regulatory bundle,
number purchase, webhook configuration, credentials, usage triggers, and a pre-launch checklist.

**Why it's written this way.**

- **Geo permissions come before anything about code.** A fresh account can't send to Australia by
  default; every send fails with 21408 and it looks exactly like a bug in our code. Checking a console
  toggle first saves a day of debugging the wrong layer.
- **"Upgrade out of trial" is framed by its effect on the pilot metric.** Trial accounts prepend "Sent
  from your Twilio trial account" to every message. That corrupts the first-impression SMS, and reply
  rate is the number the whole pilot rests on — so it's a measurement problem, not just cosmetics.
- **The regulatory bundle is called out as the critical path.** It gates number purchase and can take
  weeks. Starting it in week 0 rather than at build time is the single highest-leverage item here.
- **API keys for outbound, auth token only for signature validation.** Keys are individually revocable;
  the auth token isn't, and it can't be replaced for validation. Separating them limits what a leaked
  credential costs.
- **Usage triggers are documented as a _backstop_, not the primary control.** Application-level caps
  (`queues-redis` skill) are the real defence. These catch the case where the application itself is the
  thing that's broken.

**Connects to.** `.claude/skills/twilio/SKILL.md` (code-level patterns), `docs/carrier-forwarding-test.md`
(uses the number bought here), `docs/compliance.md` (sender ID, opt-out).

**Watch out for.** The fallback webhook URL is easy to skip and expensive to skip. Without it, a deploy
blip means callers hear a Twilio error tone instead of our greeting — during exactly the window we're
claiming to fix.

#### `docs/compliance.md`

**Step 10** · 2026-07-27

**What it does.** Working position on the Spam Act, the sender/controller split, sender ID, privacy and
the APPs, consumer law and price representations, subprocessors, retention, and offboarding.

**Why it's written this way.**

- **It states an argument, not a conclusion.** §1 sets out _why_ we think the recovery flow isn't a
  commercial electronic message — the caller initiated contact seconds earlier — and then shows that the
  argument only holds while messages stay transactional. That's what makes `CLAUDE.md` rule 10 absolute
  rather than a style preference: one promotional sentence retroactively changes our consent position.
- **Legal and operational reasons are connected where they coincide.** Twilio error 30007 (silent
  carrier filtering) correlates with promotional-looking content. Two independent reasons pointing the
  same way make the rule much harder to erode.
- **The privacy section states current status accurately rather than conveniently.** The small business
  exemption has _not_ been removed. Saying so, then arguing to build to APP standard anyway, is more
  durable than overstating the obligation — an overstatement gets discovered and then the whole document
  loses authority.
- **Price representations get their own section.** It's the highest-exposure thing the product does, and
  it's new since the original plan. The GST single-price rule is the trap: owners enter ex-GST prices
  without thinking, and the caller-facing figure must be inclusive regardless.
- **Retention makes opt-outs an explicit exception to data minimisation.** Deleting an opt-out record
  re-enables messaging someone who said stop. Keeping it _is_ honouring the request, and that inversion
  needs stating or someone will "clean up" old suppressions.
- **Offboarding is framed as a safety obligation.** The harm from a dead forwarded line lands on the
  cancelled business's customers, not on the business that cancelled — so it can't be traded away in a
  billing dispute.

**Connects to.** D2, D4, D10, D11 in `docs/decisions.md`. `CLAUDE.md` rules 3, 10 and 11. The `twilio`
skill (opt-out, 21610, 30007). Will govern the terms of service and privacy policy when drafted.

**Watch out for.** The subprocessor table has three unfilled rows (hosting, object storage, LLM
provider). The **LLM row is the one to think hardest about** — customer message text leaves our
infrastructure for field extraction. Provider retention and training terms need checking and disclosing
before the pilot, and we should never send more of the conversation than extraction requires.

---

### Claude config (cont.)

#### `.claude/settings.json`

**Step 11** · 2026-07-27

**What it does.** Permission allowlist for routine development commands, plus denies for the destructive
ones.

**Why it's written this way.**

- **The allowlist covers only reversible or read-only commands.** Install, dev, build, test, lint,
  migrate, docker up/down, read-only git. Anything that could destroy data isn't on it, so the approval
  prompt still appears where it carries information.
- **The denies operationalise a warning from the `backend` skill.** `prisma db push` drops columns
  without asking and sits one key away from `migrate dev` in muscle memory; `migrate reset` drops the
  database. A written warning in a skill file relies on someone recalling it at the moment of typing —
  a deny rule doesn't. Same for `docker compose down -v`, which removes the volumes holding local
  Postgres and Redis.
- **`.env` files are denied from being read.** They'll hold live Twilio credentials. Nothing in the
  build process needs their contents — `.env.example` documents the shape — and a denied read can't leak
  a secret into a transcript.

**Connects to.** `.claude/skills/backend/SKILL.md` (the `db push` warning this enforces),
`docker-compose.yml` and `package.json` when they exist.

**Watch out for.** The allowlist names `pnpm` throughout. If the package manager changes, the entries
silently stop matching and every command starts prompting again — it degrades to safe-but-annoying
rather than failing, which makes it easy to misdiagnose.

---

### Infra

#### `pnpm-workspace.yaml`

**Step 12** · 2026-07-27

**What it does.** Declares the monorepo: `apps/*` and `packages/*` are workspace members, and names the
dependencies permitted to run install scripts.

**Why it's written this way.**

- **`onlyBuiltDependencies` is the substance of the file.** pnpm 10+ blocks dependency install scripts
  by default — a good security posture, since a postinstall script is arbitrary code from a transitive
  dependency. But Prisma's postinstall is what _generates_ the client. Without this list you get
  `@prisma/client did not initialize yet` from code that reads as completely correct, and the cause is
  three layers away from the error. Listing it here rather than discovering it later is the whole point.
- **The list is deliberately short.** `esbuild` is included because Next.js and the Nest build pipeline
  pull it in and it ships prebuilt binaries. Nothing else is on it yet. The default of "blocked" is the
  safe one, so packages get added only when something actually fails for this reason — never
  pre-emptively.
- **`packages/*` is declared before any package exists.** The glob costs nothing when empty, and
  declaring the intended shape now means adding `packages/shared-types` later is a mkdir rather than a
  workspace change. Missing globs are not an error in pnpm.
- **No `catalog:` yet.** pnpm catalogs pin shared dependency versions across workspace members, which
  will be worth having once `apps/api` and `apps/web` both depend on TypeScript and a shared validation
  library — version drift between them is a real source of confusing type errors across
  `packages/shared-types`. Deferred because defining a catalog before choosing any versions is
  bookkeeping without benefit. **Revisit when `packages/shared-types` lands.**

**Connects to.** Root `package.json` (next step) supplies the scripts that operate across these
workspaces. `.claude/settings.json` allows `pnpm --filter:*`, which is how per-app commands run.

**Watch out for.** Adding a native dependency later — `argon2` if password auth is ever added, `sharp`
for image processing — will fail to build silently for the same reason Prisma would. The symptom is a
runtime "module not found" or a missing binary, not an install error. If a native package misbehaves
immediately after install, check this list first.

**Update (step 13).** pnpm 11 uses `allowBuilds` with explicit `true`/`false` per package, not pnpm 10's
`onlyBuiltDependencies` list. Rewritten accordingly. `sharp: true` was added for Next's image
optimisation; `msgpackr-extract: false` was declined — it's an optional native accelerator for the
serialiser BullMQ uses, and our job payloads are ids, not blobs.

#### `package.json` (root)

**Step 13** · 2026-07-27

**What it does.** Workspace scripts, the pinned package manager, and the Node engine floor. No runtime
dependencies — those belong to the apps.

**Why it's written this way.**

- **`packageManager: pnpm@11.17.0`** pins the exact version via corepack, so the lockfile is never
  rewritten by a different pnpm on someone else's machine.
- **`db:check` is a script, not a note.** It runs `CONFIG GET appendonly maxmemory-policy` against the
  running Redis. The two settings it checks are the ones whose failure is silent
  (`.claude/skills/queues-redis/SKILL.md` §1), so verifying them has to be one command, not a paragraph
  someone remembers to act on.
- **Separate `dev:api` / `dev:worker` / `dev:web`.** The worker is a real second process (D7) and needs
  to be startable on its own when debugging job flow.

**Watch out for.** `engines.node` is `>=22`, but the machine this was set up on runs **Node 25.8.0**,
which Prisma prints a warning about — it supports 20.19+, 22.12+, 24.x. Everything works today
(client generation, migrations, both processes boot), but Node 25 is a non-LTS odd release and Prisma
does not test against it. `.nvmrc` pins **24** for exactly this reason. Production should run 24.

#### `docker-compose.yml`

**Step 13** · 2026-07-27

**What it does.** Local Postgres 17 and Redis 7 with health checks and named volumes.

**Why it's written this way.**

- **The Redis flags are requirements, not local convenience**, and the file says so in a comment.
  `--appendonly yes` because BullMQ keeps delayed jobs in Redis and a restart without persistence drops
  every scheduled follow-up silently. `--maxmemory-policy noeviction` because the common managed default
  is `allkeys-lru`, which evicts job data under memory pressure. Both were **verified against the running
  container** after startup, not assumed.
- **Health checks on both services**, so `docker compose up` can be waited on deterministically rather
  than with a sleep.

**Watch out for.** `docker compose down -v` removes the volumes and therefore the local database. It's
denied in `.claude/settings.json` for that reason.

#### `.env.example` · `.env`

**Step 13** · 2026-07-27

**What it does.** Documents every environment variable, grouped by concern, with the reasoning inline.

**Why it's written this way.**

- **One `.env` at the repo root**, loaded explicitly by both apps. A per-app copy is how two environments
  quietly diverge.
- **Twilio credentials are optional in the schema** so the app boots before the account is provisioned
  (`docs/twilio-setup.md` is a multi-day process). The telephony module validates them at point of use.
- **`SESSION_SECRET` has a ≥32-character minimum.** The original placeholder was 26 characters and the
  app refused to boot — which is the validation working. The example value now demonstrates
  `openssl rand -base64 32`.

**Watch out for.** `.env` is gitignored and Claude is denied read access to it. `API_PORT` was moved to
**3101** locally because 3001 is occupied by an unrelated project's dev server on this machine.

#### `tsconfig.base.json` · `apps/api/tsconfig.json` · `apps/web/tsconfig.json`

**Step 13** · 2026-07-27

**What it does.** Shared strictness in the base; module and emit settings per app.

**Why it's written this way.**

- **`noUncheckedIndexedAccess` is on.** It's the strict flag people usually switch off. Kept because
  optional Twilio webhook params and array indexing are exactly how `undefined` reaches runtime here.
- **The API is CommonJS via `module: node16`,** not the deprecated `commonjs`/`node10` pair TypeScript now
  warns about. `apps/api/package.json` has no `type` field, so node16 emits CJS — which is what Nest's
  `emitDecoratorMetadata` wants, without the deprecation.
- **`strictPropertyInitialization: false`** only on the API: Nest injects into declared properties and TS
  cannot see the assignment.

**Watch out for — this cost a real debugging cycle.** `tsBuildInfoFile` must live **inside** `outDir`.
`nest-cli.json` sets `deleteOutDir`, so with `.tsbuildinfo` outside `dist`, the build info survives the
delete, tells tsc everything is up to date, and **emits nothing** — a build that reports success and
produces an empty `dist`. The symptom is `MODULE_NOT_FOUND` on `node dist/main.js` after a green build.

#### `apps/api/prisma/schema.prisma` · `apps/api/prisma.config.ts`

**Step 13** · 2026-07-27

**What it does.** The data model (`businesses`, `users` so far) and the Prisma CLI configuration.

**Why it's written this way.**

- **Prisma 7 removed `url` from the datasource block.** The connection string now lives in
  `prisma.config.ts` for the CLI, and reaches the runtime client through a driver adapter
  (`@prisma/adapter-pg`). Both read `DATABASE_URL`, so they cannot drift.
- **Prisma 7 also stopped auto-loading `.env`**, hence the explicit `dotenv` call. The path list is
  `['.env', '../../.env']` because the CLI runs with `cwd=apps/api`.
- **`moduleFormat = "cjs"`** on the generator, to match the API's CommonJS output.
- **Two tables, not twelve.** The schema grows per the build protocol. The header comment lists what is
  still to come so the omission reads as deliberate rather than forgotten.

**Watch out for.** `Business` and `User` are the tenant _root_ and are legitimately queried without a
`businessId` filter, which is why the D8 assertion extension is not applied yet — there is nothing for it
to guard. It must land with `phone_numbers`, the first genuinely tenant-scoped model.

#### `apps/api/src/config/env.ts`

**Step 13** · 2026-07-27

**What it does.** Parses and validates the environment with zod at import time. Throws on anything
invalid, listing every problem at once.

**Why it's written this way.**

- **`envBool` instead of `z.coerce.boolean()`.** Coercion treats the _string_ `"false"` as `true`, because
  any non-empty string is truthy. On `SENDING_ENABLED` that bug means the kill switch does not switch
  anything off. The helper parses the literal strings instead.
- **Fails at boot, loudly, with all issues at once.** A missing variable must never degrade into blank
  pages or silent no-ops. This was demonstrated during setup: the placeholder `SESSION_SECRET` was too
  short and the process refused to start with the exact reason.
- **Circuit-breaker defaults are conservative** — a runaway send loop is more expensive than a missed
  send.

#### `apps/api/src/prisma/prisma.service.ts` · `prisma.module.ts`

**Step 13** · 2026-07-27

**What it does.** The database client, wired to `PrismaPg`, exported from a global module.

**Why it's written this way.**

- **`@Global()` is the deliberate exception**, not a pattern to copy — the comment says so. A global module
  hides its dependency edges, which is only acceptable for something genuinely used everywhere.
- **Lifecycle hooks connect and disconnect with the Nest lifecycle**, so `enableShutdownHooks()` in both
  entrypoints actually closes the pool.

**Watch out for.** The D8 tenancy assertion extension is **not applied yet**, and the file says so in a
block comment rather than a TODO — a TODO would be invisible by the time it matters.

**Superseded by step 16** — the guard is now applied and the class was restructured. See below.

#### `apps/api/src/prisma/prisma.service.ts` (rewritten)

**Step 16** · 2026-07-29

**What it does.** Owns the Prisma client, applies the tenancy guard, and exposes three deliberately
distinct surfaces: `db` (guarded), `unscoped` (the escape hatch), and `$queryRaw` / `$executeRaw` (raw
SQL).

**Why it's written this way.**

- **It no longer extends `PrismaClient`, and that is the whole point.** `$extends` returns a _new_
  client rather than mutating the instance, so with inheritance `this` would remain the **unguarded**
  base — the default surface would be the unsafe one, which is exactly backwards. Composition makes the
  guarded client the default and forces `unscoped` to be asked for by name. The structural change was
  forced by a one-line library behaviour, and getting it wrong would have silently disabled D8 while
  looking correct.
- **Three surfaces, chosen so the call site is self-documenting.** `prisma.db.lead.findMany(...)` and
  `prisma.unscoped.phoneNumber.findFirst(...)` differ visibly in the diff. The rejected alternative was
  injecting the extended client directly under one token, giving the nicer `prisma.lead.findMany(...)`
  — but then which client you got would depend on a token declared in another file, and a reviewer
  reading a query could not tell whether it was guarded. Slightly worse ergonomics bought local
  readability at the exact place mistakes are made.
- **`base` is private; `unscoped` is a getter.** There is one way to reach the unguarded client and it
  is spelled `unscoped`, so `grep -rn 'unscoped' src/` is a complete audit of every bypass.
- **Raw SQL sits on the root, not under `db` — deliberately.** The extension only sees model
  operations, so `$queryRaw` is outside the guard _by nature, not by omission_. Placing it beside the
  guarded surface would imply a protection that does not apply. It also happens to be why
  `health.controller.ts` compiled unchanged through this rewrite: its `SELECT 1` never went through the
  guarded path in the first place.
- **`$transaction` is exposed from `db`, not `base`.** Easy to get wrong: a transaction taken from the
  base client would run every statement inside it unguarded, which is the most dangerous possible place
  to lose the check. Bound to the extended client so statements inside a transaction are checked too.
- **The connect log says "tenant guard active".** Boot output is where you look when something is
  wrong; if the guard is ever accidentally removed, the absence of that phrase is a visible signal.

**Connects to.** `tenant-guard.ts` (applied here). `prisma.module.ts` exports this globally.
`config/env.ts` supplies `DATABASE_URL`. `health/health.controller.ts` uses the raw surface.

**Verified.** Rebuilt and booted against the live container: `Database connected (tenant guard active)`
in the log, `/health/ready` → `{"status":"ok","database":"ok"}`.

**Watch out for.** The guard is wired but **has not yet been exercised against a real tenant model** —
`TENANT_MODELS` names nine models and the schema currently contains none of them, so `db.phoneNumber`
does not exist yet. The first genuine end-to-end proof arrives with `phone_numbers` in step 17. Until
then, "guard active" means "installed", not "demonstrated".

Second: class field initialisation order matters here. `db` is initialised from `this.base`, so `base`
must be declared first. Reordering the fields would break it at construction time, not at compile time.

#### `apps/api/prisma/schema.prisma` — `phone_numbers` added

**Step 17** · 2026-07-29

**What it does.** Adds `PhoneNumber` plus two enums (`PhoneNumberPurpose`, `PhoneNumberStatus`). This is
the table that resolves tenancy for every inbound webhook: Twilio gives us `To`, and this maps it to a
`businessId`.

**Why it's written this way.**

- **`e164 @unique` is a safety constraint, not a convenience one.** Two businesses sharing an inbound
  number would route one business's callers to the other — the worst failure this system has. The
  database refuses to represent it, rather than relying on application code to prevent it.
- **This model justifies `prisma.unscoped` for the first time**, exactly as predicted in step 16. The
  `To` → business lookup happens _before_ a tenant is known, so it cannot be guarded — there is no
  `businessId` to scope by yet. The escape hatch exists for this shape of query, and it is good that its
  first real use is one line in one place.
- **`status` has four values, and `SUSPENDED` is an offboarding grace state, not a synonym for
  disabled.** When a business cancels, their carrier is _still_ forwarding calls to us. Cutting the
  number dead sends **their customers** to a dead line — a harm that lands on people who never chose us
  (`docs/compliance.md` §8). Modelling the grace state in the enum means the safe behaviour is
  representable rather than depending on someone remembering the policy.
- **`status` defaults to `PENDING`, and `forwardingVerifiedAt` is separate.** Onboarding must not
  activate an account on the assumption that dialling the MMI codes worked — forwarding fails silently
  and often. `forwardingVerifiedAt` is set only when a real test call has arrived end to end, which is
  the plan's "only activate after the full test succeeds" expressed as a column.
- **`twilioSid` is nullable.** The AU regulatory bundle can take days, so a business record legitimately
  exists before its numbers do.
- **`forwardingCarrier` is free text, not an enum.** MVNOs resell all three networks, so the value space
  is open. It is stored because D13 may restrict us to carriers that preserve the caller's number — in
  which case this becomes an eligibility field, not a curiosity.
- **`forwardsFromE164` records the business's own advertised number.** Needed to write correct
  offboarding instructions, and to recognise the business's own staff calling in.

**Connects to.** `tenant-guard.ts` (`PhoneNumber` was already in `TENANT_MODELS`, so it arrived
guarded). `docs/twilio-setup.md` §4–5. `docs/carrier-forwarding-test.md` (D13 feeds
`forwardingCarrier`). Migration `20260729102922_add_phone_numbers`.

**Verified — the guard is now demonstrated, not just installed.** A throwaway script against the live
database, 8/8:

| Case                                                           | Result                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `findMany({})` unscoped                                        | `TenantScopeError` ✓                                                |
| `findMany({ where: { businessId } })`                          | succeeds ✓                                                          |
| `findUnique({ where: { e164 } })`                              | `TenantScopeError` ✓                                                |
| `businessId` nested inside `OR`                                | `TenantScopeError` ✓                                                |
| `create` with no `businessId`                                  | `TenantScopeError` ✓                                                |
| `unscoped.findFirst({ where: { e164 } })` — the webhook lookup | succeeds ✓                                                          |
| `Business.findMany({})` — not a tenant model                   | succeeds ✓                                                          |
| scoping to the **wrong** tenant                                | allowed, returns 0 rows — confirming the guard is a net, not a wall |

**Watch out for — two toolchain traps found the hard way in this step.**

1. **`prisma migrate dev` does not regenerate the client** for this generator and custom output path.
   The new model was simply absent — `db.phoneNumber` undefined — which reads as a TypeScript problem
   rather than a stale-codegen one. The schema header now says to run both commands.
2. **`importFileExtension` had to be pinned to `""`.** Left unset, the generator emitted ESM-style
   `"./internal/class.js"` specifiers, which tsc resolves but **Jest does not** — the entire tenant-guard
   suite failed to load with `Cannot find module './internal/class.js'`. Worse, the output was
   _non-deterministic_: the first generation emitted extensionless imports and a later one did not, so
   the suite broke without any source change. Pinning it makes codegen independent of which command
   triggered it.

Third, for later: releasing a number and reassigning it to another business will collide with
`e164 @unique`, since a `RELEASED` row keeps its value. Not a problem yet — worth a deliberate decision
before the first offboarding, not an improvised one.

#### `apps/api/prisma/schema.prisma` — `webhook_events` added

**Step 18** · 2026-07-29

**What it does.** Records every raw provider delivery. This is the table that makes replaying a payload
three times produce one call, one SMS, one lead.

**Why it's written this way.**

- **The uniqueness key is `dedupeKey`, built by the handler — this corrects the plan.** Both the plan
  and `.claude/skills/twilio/SKILL.md` §3 specified a compound unique on
  `(provider, externalEventId)`. **That is wrong, and would have caused silent data loss.** A `CallSid`
  is not unique per delivery: one call produces an incoming webhook _plus_ several status callbacks, all
  sharing it. A compound unique on those two columns would have accepted the first and silently rejected
  every subsequent status callback for that call — meaning we would never learn a call completed.
  Instead each handler constructs its own key and owns what "the same event" means:

  ```
  twilio:voice:incoming:CAxxxx
  twilio:voice:status:CAxxxx:completed
  twilio:message:incoming:SMxxxx
  twilio:message:status:SMxxxx:delivered
  ```

  `externalEventId` is kept as a plain indexed column so "show me everything about this call" is still
  one query — it just isn't load-bearing for correctness.

- **Not a tenant model, and the reasoning is in the schema.** The row is written _before_ the tenant is
  known and looked up by `dedupeKey` with no `businessId` in hand, so it cannot satisfy the guard.
  `businessId` is nullable and forensic only. The comment states the condition under which that must
  change: if this table is ever exposed through the API, it joins `TENANT_MODELS` and the column becomes
  required.

- **`signatureValid` is stored, and failed rows are kept.** The instinct is to reject an invalid
  signature and write nothing. But a burst of failures is either a misconfigured `PUBLIC_API_URL` or
  someone probing the endpoint — and both are completely invisible if rejected requests leave no trace.
  The row is the only evidence.

- **`IGNORED` is distinct from `FAILED`.** A spam caller or a suppressed number is a deliberate
  non-action, not an error. Collapsing them would make "failure rate" meaningless as an alert signal,
  which is the one thing that metric is for.

- **`payload` holds verbatim provider parameters** for replay — and therefore caller phone numbers and
  message text. That personal information is why this table has the shortest retention of anything we
  store, 90 days (`docs/compliance.md` §7); past that it has no value beyond idempotency.

- **Three indexes, each with a stated purpose:** `externalEventId` for support, `(status, receivedAt)`
  for finding unprocessed work oldest-first, `receivedAt` for the retention sweep.

**Connects to.** `.claude/skills/twilio/SKILL.md` §3 (the validate → persist → enqueue → return
contract this implements — **and whose uniqueness key it corrects**). `docs/compliance.md` §7.
`tenant-guard.ts` (deliberately absent from `TENANT_MODELS`). Migration
`20260729103928_add_webhook_events`.

**Verified against the live database:**

- Inserting the same `dedupeKey` twice → rejected by
  `webhook_events_dedupe_key_key`, at the database rather than in application code.
- Two different status callbacks on the **same** `CallSid`
  (`...status:CA123:ringing`, `...status:CA123:completed`) → both inserted, 2 rows. This is precisely
  the case the originally-planned compound key would have swallowed.

**Watch out for.** The dedupe key's correctness now lives in the _handlers_, not the schema. A handler
that builds a key without the distinguishing field — `twilio:voice:status:CA123` with no status —
recreates exactly the collision this design avoids, and the failure is silent: events simply stop being
recorded. Every handler that writes here needs a test asserting two distinct deliveries produce two rows.

---

### API — telephony

#### `apps/api/src/telephony/twilio-signature.guard.ts`

**Step 20** · 2026-07-29

**What it does.** A Nest guard that rejects any request to a Twilio webhook without a valid
`X-Twilio-Signature`. Exports `buildWebhookUrl` separately so URL reconstruction can be tested on its
own.

**Why it's written this way.**

- **The threat is concrete, not theoretical.** These endpoints are unauthenticated and publicly
  reachable — they have to be, so Twilio can reach them. The signature is the only thing separating a
  real delivery from anyone who can guess the URL. A forged one creates leads, triggers SMS at our cost,
  and puts text in front of a business's customers under their name.
- **The URL is built from the pinned `PUBLIC_API_URL`, not from `req.protocol`/`req.host`.** This is the
  §2 trap made concrete: behind Railway, Render or ngrok, `req.protocol` reports `http` while Twilio
  called `https`, so a header-derived URL differs by one character and _every_ signature fails with no
  useful error. `trust proxy` fixes that in principle, but it makes correctness depend on a forwarded
  header we do not control. A pinned value is deterministic — and it is the same string
  `docs/twilio-setup.md` tells you to configure in the Twilio console, so the two cannot drift.
- **`originalUrl`, not `path`.** Twilio includes the query string in the signed string; `path` drops it.
- **A missing `TWILIO_AUTH_TOKEN` refuses traffic rather than passing it through.** The token is optional
  in `env.ts` so the app can boot before the AU regulatory bundle clears (that wait is days to weeks).
  That convenience must not become an open door: with no token there is nothing to verify against, so
  the guard fails closed and logs at ERROR.
- **No test bypass exists, deliberately.** The obvious convenience — an env flag that skips validation in
  development — is a permanent hole one misconfiguration away from production. Tests instead _sign_
  their payloads with a dummy token, which is both safer and a better test, since it exercises the real
  code path.
- **403 carrying no reason.** The exception is constructed with an empty message, so nothing about _why_
  validation failed goes back over the wire — that belongs in our logs, not in a response to someone
  probing the endpoint. (Precision, added at step 25: Nest's exception filter still serialises this to
  `{"statusCode":403,"message":""}` rather than a zero-length body. The security property — no reason
  disclosed — holds; the earlier wording "empty body" described the exception object, not the wire.)
- **The failure log includes the reconstructed URL.** When this fires in a new environment the cause is
  almost always that this exact string does not match what Twilio called. Without it in the log the
  failure is opaque; with it, the diagnosis is immediate.

**Connects to.** `.claude/skills/twilio/SKILL.md` §2. `config/env.ts` (`TWILIO_AUTH_TOKEN`,
`PUBLIC_API_URL`). `main.ts` (`trust proxy` remains set as defence in depth, but this guard does not rely
on it). Will be applied to every controller under `telephony/`.

**Verified, 11/11.** Payloads were signed by an _independent_ implementation of Twilio's algorithm
(HMAC-SHA1 over URL + params sorted by key, concatenated as key+value) and validated by the guard, so the
test cross-checks the algorithm rather than round-tripping one library against itself:

| Case                                                                   | Result    |
| ---------------------------------------------------------------------- | --------- |
| Valid signature                                                        | allowed ✓ |
| Tampered param (`From` changed)                                        | 403 ✓     |
| Extra param injected                                                   | 403 ✓     |
| Param dropped                                                          | 403 ✓     |
| Missing signature header                                               | 403 ✓     |
| Valid signature replayed at a different path                           | 403 ✓     |
| Empty body with matching signature                                     | allowed ✓ |
| Params in a different order                                            | allowed ✓ |
| URL: trailing slash on base / no leading slash / query string retained | correct ✓ |

**Watch out for — an env-initialisation trap that will hit the spec file.** `config/env.ts` snapshots
`process.env` at module-evaluation time, and ES module imports are **hoisted**. Setting
`process.env.TWILIO_AUTH_TOKEN` at the top of a test file and then statically importing the guard does
_not_ work — the import runs first, and every case fails with "TWILIO_AUTH_TOKEN is not set". This cost a
run during verification. Tests must either set the variable before the module graph loads (a Jest setup
file) or reach the guard through a dynamic `await import()`.

Second: this guard does **not** record failed signatures to `webhook_events`, despite that table having
a `signatureValid` column. Writing a row per rejected request is an unauthenticated, unbounded write
path — a trivial amplification vector. Failures are logged at WARN instead, which preserves the "a burst
of failures is visible" property. The column stays for when a recording path lands behind rate limiting.

#### `apps/api/src/telephony/twilio-signature.guard.spec.ts`

**Step 21** · 2026-07-29

**What it does.** 24 tests over the guard: genuine deliveries, forged and tampered ones, diagnostic
logging, URL reconstruction, and the unconfigured-token path. Total suite is now 121.

**Why it's written this way.**

- **Payloads are signed by an independent implementation of Twilio's algorithm**, not by the `twilio`
  package's own signing helper. Using one library to both sign and verify round-trips an implementation
  against itself and would pass even if our understanding of the algorithm were wrong. Signing by hand
  makes the test an actual cross-check.
- **It solves the env-hoisting trap flagged in step 20, in one file.** `config/env.ts` snapshots
  `process.env` at module-evaluation time and ES imports are hoisted, so a static import of the guard
  evaluates `env.ts` first and every case fails with "TWILIO_AUTH_TOKEN is not set". A CommonJS
  `require` is _not_ hoisted, so it runs after the assignments. That kept this to a single file instead
  of also needing a Jest `setupFiles` entry — worth the one lint-disable, and the comment explains it.
- **Replay across paths is tested explicitly.** The URL is part of the signed string, so a signature
  captured from the voice webhook must not validate against the messaging one. That is a real attack
  shape, not a hypothetical.
- **Diagnostics are asserted, not assumed.** Step 20 claimed the failure log contains the reconstructed
  URL, and that it never leaks the reason in the response body or the token in a log line. Claims in
  documentation decay; these are now tests.
- **`tolerates a missing body`** guards a boring but real failure: a clean 403 rather than a `TypeError`
  on `undefined`, which would surface as a 500 and look like our bug rather than a rejected forgery.
- **The unconfigured-token case runs in its own top-level describe** with `jest.resetModules()`, because
  it needs a different `env` snapshot than every other test. It asserts that even a _perfectly valid_
  signature is rejected — the point being that with no token there is nothing to verify against.

**Connects to.** `twilio-signature.guard.ts` (the only thing under test). `config/env.ts` (the module
whose evaluation timing dictates this file's structure).

**Watch out for — a Prettier/ESLint interaction.** `require(...)` and its `as typeof import(...)` cast
are kept as **separate statements** deliberately. Combined, the line exceeds the print width, Prettier
wraps it, and the `eslint-disable-next-line` comment then points at the wrapped line rather than the
`require` — so lint fails with both "unused disable directive" _and_ "require is forbidden" at once, in
a way that looks unrelated to whatever change triggered the reformat. Splitting the statements keeps the
comment adjacent to what it suppresses regardless of formatting.

**Watch out for — a `resetModules` subtlety that cost a run.** `jest.resetModules()` re-instantiates the
**whole** module graph, including `@nestjs/common`. The reloaded guard therefore closes over a
_different_ `Logger` class than the one imported at the top of the spec, so
`jest.spyOn(Logger.prototype, 'error')` silently spies on the wrong object and asserts zero calls while
the real logger writes to stdout. The fix is to `require('@nestjs/common')` _after_ the reset and spy on
that copy. Any future test that combines `resetModules` with a spy on a library class needs the same
treatment.

#### `apps/api/src/telephony/webhook-events.service.ts`

**Step 22** · 2026-07-29

**What it does.** Records every provider delivery exactly once, and owns the lifecycle of those rows:
`record`, `markProcessed`, `markIgnored`, `markFailed`, plus the 90-day retention sweep. Exports
`dedupeKeys`, the four key shapes.

**Why it's written this way.**

- **`createManyAndReturn` with `skipDuplicates`, not a caught P2002.** Two reasons. The database decides
  atomically in a single round trip, with no window between a "does it exist" check and the insert — the
  race that a `findFirst`-then-`create` would open is exactly the concurrent-retry case this table
  exists to handle. And it keeps duplicates off the exception path, which matters because **a duplicate
  is normal traffic here, not an error**. An empty result array means the unique index rejected the row.
- **The duplicate log is `debug`, not `warn`.** A Twilio retry is expected behaviour. Logging it as a
  warning would train everyone to ignore warnings from this service, which is where a real problem would
  eventually appear.
- **`dedupeKeys` centralises the four shapes without taking the choice away from handlers.** §3 requires
  each handler to own what "the same event" means; this just stops one inventing a fifth shape or
  omitting a distinguishing field. The doc comment states the rule again at the point of use, because
  the failure it prevents — omitting `callStatus` and silently collapsing every status callback into the
  first — is invisible when it happens.
- **`signatureValid: true` is written as a column rather than assumed.** Only validly-signed requests
  reach this service, so it is constant today. It stays a column so the rate-limited failure-recording
  path flagged in step 20 can populate it without a migration.
- **`markIgnored` is separate from `markFailed`.** A spam caller is a deliberate non-action. Collapsing
  the two would make failure rate useless as an alert signal, which is the one thing it is for.
- **`markFailed` increments `attempts`** so a row that keeps failing reads as such rather than looking
  like one stuck event.
- **Errors truncate to 500 characters.** The schema says the column is for triage, not stack traces;
  enforcing that here stops a caller quietly making it a log sink.
- **`deleteOlderThan` exists before the job that calls it.** The 90-day retention rule is a documented
  obligation (`docs/compliance.md` §7) covering caller phone numbers and message text. Writing the
  method now means the obligation is implemented rather than remembered.

**Connects to.** `prisma/schema.prisma` (`WebhookEvent`, step 18). `.claude/skills/twilio/SKILL.md` §3
(the contract it implements). `twilio-signature.guard.ts` (runs first; nothing unsigned reaches here).
Will be called by the voice and messaging webhook controllers.

**Verified against the live database, 11/11.** The headline case: **five deliveries for one `CallSid`
produced exactly three rows** — the two retries of the incoming webhook collapsed, and the two distinct
status callbacks were both kept. That is simultaneously the property step 18 designed for and the bug
the original `(provider, externalEventId)` key would have caused. Also confirmed: `attempts` increments
across repeated failures, a 5,000-character error truncates to 500, and a 90-day sweep leaves fresh rows
untouched.

**Watch out for.** `skipDuplicates` makes a duplicate indistinguishable from a _lost_ insert at the call
site — both return an empty array. That is correct here because the unique index is the only thing that
can reject the row, but it means any future change adding another rejection path (a check constraint, a
partial index) would be silently reported as "duplicate". If one is added, this method needs to
distinguish them explicitly.

Second: `record` hardcodes `provider: 'TWILIO'`. The enum already has `STRIPE` for billing webhooks
later, and this service is otherwise provider-agnostic — the parameter should be lifted before a second
provider arrives, not after.

#### `apps/api/src/telephony/webhook-events.service.spec.ts`

**Step 23** · 2026-07-29

**What it does.** 17 tests: three pure ones over `dedupeKeys`, and fourteen integration tests against the
real docker-compose Postgres covering idempotency, concurrency, lifecycle transitions and retention.
Total suite is now 138.

**Why it's written this way.**

- **Not mocked, deliberately.** The behaviour under test _is_ the unique index and `skipDuplicates`. A
  mocked Prisma client would assert the shape of a call rather than that the constraint holds, and would
  pass just as happily against a schema with no unique index at all. This is the concrete case behind
  "never mock Prisma" in `.claude/skills/backend/SKILL.md` §8.
- **The concurrency test is the one that justifies the design.** Five identical deliveries fired through
  `Promise.all` produce exactly one `recorded` and four `duplicate`, and one row. Twilio can retry
  before the first request has committed, so a `findFirst`-then-`create` would let several through —
  and that race is not expressible against a mock at all.
- **Cleanup is prefix-scoped, not `TRUNCATE`.** Every row carries a per-run `TEST<pid>_<timestamp>`
  prefix and only those are deleted. Truncating would work locally but would quietly destroy a
  developer's inspection data and make two concurrent runs interfere.
- **A failed connection is rewritten into an instruction.** Without the try/catch in `beforeAll` the
  failure is a raw `ECONNREFUSED` that reads like a code bug; it now says "run `pnpm db:up` first". The
  original error is attached as `cause` rather than stringified, so the stack survives — ESLint's
  `preserve-caught-error` rule caught the first version, which had thrown it away.
- **`dedupeKeys` gets its own pure describe block.** Those four strings are the correctness boundary of
  the whole idempotency design, and they can be pinned without a database.

**Connects to.** `webhook-events.service.ts` (under test). `docker-compose.yml` (requires it running).
`prisma/schema.prisma` (the unique index it exercises).

**Watch out for — this step forced a sibling change to `apps/api/package.json`.** Prisma 7's client uses
a dynamic `import()` internally, which Jest's CJS sandbox rejects with
`A dynamic import callback was invoked without --experimental-vm-modules`. The suite could not run
without it, so the `test` and `test:watch` scripts now set
`NODE_OPTIONS=--experimental-vm-modules`. Consequences worth knowing:

- Node prints an `ExperimentalWarning` on every test run. It is noise, not a problem.
- The `VAR=value cmd` prefix is POSIX shell syntax and will not work on Windows `cmd`. If a Windows
  contributor ever appears, this needs `cross-env`.

Second: `pnpm test` now **requires Postgres to be running**. Unit and integration tests share one
command and one `.spec.ts` suffix. That matches the backend skill's guidance and keeps the setup simple,
but it means CI must start docker-compose. If the split ever becomes painful, the fix is a separate
`.int-spec.ts` suffix and a second Jest project — not mocking the database.

#### `apps/api/src/telephony/voice.controller.ts`

**Step 24** · 2026-07-31

**What it does.** Two endpoints. `POST /webhooks/twilio/voice/incoming` answers a forwarded call: record
idempotently, resolve the tenant from `To`, return answer-announce-hangup TwiML (D2).
`POST /webhooks/twilio/voice/status` records call status callbacks.

**Why it's written this way.**

- **It always returns valid TwiML, including when recording fails.** The `catch` answers the call
  anyway. A 500 here makes the caller hear a **Twilio error tone during precisely the window this
  product exists to fix** — and Twilio would retry, so the failure is both audible and repeated. Losing
  a row is bad; a bad caller experience is worse. That trade is the whole reason the handler is
  structured around a try/catch rather than letting errors propagate to the exception filter.
- **A duplicate delivery still gets a full greeting.** The natural reading of "idempotent" is _do
  nothing the second time_, which would be wrong here: a retry is a **live call leg** with a real person
  on it. Idempotency applies to the side effects, not to the response.
- **The tenant lookup is the first real `prisma.unscoped` call in the codebase**, exactly as `D8` and
  the `PhoneNumber` schema comment predicted. This lookup _is_ how the tenant is discovered, so there is
  no `businessId` to scope by. One line, one place.
- **`ACTIVE` and `SUSPENDED` both answer.** `SUSPENDED` is the offboarding grace state — a cancelled
  business's carrier is still forwarding, and refusing the call would send **their** customers to a dead
  line (`docs/compliance.md` §8). Filtering on `status: 'ACTIVE'` alone would have been the obvious
  query and the wrong one.
- **An unrecognised `To` is `IGNORED`, not `FAILED`.** Nothing is broken — it is a released number still
  being dialled, or a console misconfiguration. Conflating the two would make the failure count useless
  as an alert signal.
- **A withheld caller ID logs and proceeds.** `toE164` returns null, which is a normal daily occurrence
  rather than an error: we answer the call, we just have nobody to text.
- **The greeting names the business and announces the text**, and falls back to generic wording when the
  business is unknown rather than guessing. Naming it is the caller's only signal that an SMS about to
  arrive from an unknown number is legitimate.
- **Status callbacks return 204 and swallow errors.** No caller-facing consequence, but still must not
  500, or Twilio retries a request we cannot serve.

**Connects to.** `twilio-signature.guard.ts` (guards both routes — nothing unsigned reaches here).
`webhook-events.service.ts` (recording and lifecycle). `common/phone.ts` (`toE164` at the edge).
`prisma.service.ts` (`unscoped`). D1, D2, D8.

**Verified against the live database, 15/15.** Greeting names the business, hangs up, contains no
`<Record>`, uses `en-AU`, and is a valid TwiML document. Tenant resolved from `To` onto the event
(`PROCESSED`). A Twilio retry answers identically and produces **no second row**. An unrecognised `To`
still answers and is marked `IGNORED`. A withheld caller ID still answers. A `SUSPENDED` number still
answers. One incoming plus two distinct status callbacks produce three rows.

**Watch out for — this controller is not yet reachable.** No module registers it, so the routes do not
exist on the running app; it was verified by direct instantiation. `telephony.module.ts` is the next
step, and until it lands `curl` against these paths will 404. This is the build protocol working as
intended, not an oversight.

Second — **a deliberate, marked gap: no SMS is sent.** The comment in `incoming()` says where the
recovery job gets enqueued and why it cannot happen inline (Twilio's ~15s timeout, and the
no-side-effects-in-a-webhook rule). Today the endpoint answers the call and records it, and the caller
receives nothing. That is the honest state of the product until the calls module and queue exist.

Third: the answer/announce flow assumes `From` is the **original caller** rather than the forwarding
party. That is still D13 — unmeasured. If AU carriers present the business's own number, this controller
records calls correctly and the recovery premise collapses anyway.

#### `apps/api/src/telephony/telephony.module.ts`

**Step 25** · 2026-07-31

**What it does.** Registers `VoiceController`, `WebhookEventsService` and `TwilioSignatureGuard`, and
exports the service for downstream modules.

**Why it's written this way.**

- **The signature guard is a module provider, not a global guard.** `APP_GUARD` would put it in front of
  `/health`, the future dashboard API, and everything else — where a Twilio signature is meaningless and
  would reject all traffic. Scoping it to this module means the blast radius of "everything requires a
  Twilio signature" is exactly the routes where that is true.
- **`PrismaService` is not imported.** `PrismaModule` is `@Global()`, so it is already available. Worth
  stating in the file, because the absence otherwise reads as an oversight in a module whose controller
  clearly uses Prisma.
- **Only `WebhookEventsService` is exported.** The calls and conversations modules will need it to mark
  events processed once the queue exists. Controllers are entry points and the guard is only meaningful
  beside them, so exporting either would invite use that does not make sense.

**Connects to.** `voice.controller.ts`, `webhook-events.service.ts`, `twilio-signature.guard.ts`,
`prisma.module.ts` (global).

**Verified 6/7, with the seventh a real finding.** The module was mounted in a throwaway root containing
_only_ `PrismaModule` and `TelephonyModule` — proving it stands alone and does not lean on anything
`AppModule` happens to provide. Confirmed: the DI graph resolves, `WebhookEventsService` is visible to a
consumer module that imports this one, both routes map
(`POST /webhooks/twilio/voice/incoming`, `POST /webhooks/twilio/voice/status`), and an **unsigned HTTP
request is rejected with 403** — the guard is genuinely applied over the wire, not just decorated.

**The failing assertion was correct and my documentation was wrong.** Step 20 claimed the guard returns
"403 with an empty body". Over real HTTP, Nest's exception filter serialises the empty-message
`HttpException` to `{"statusCode":403,"message":""}`. The security property still holds — no reason is
disclosed — but "empty body" described the exception object rather than the response. Step 20's entry is
now corrected. Left as-is in code: the body reveals nothing an attacker cannot already infer, and
changing it to chase the earlier wording would be scope creep. This is a good argument for testing over
HTTP rather than against the exception alone.

**Watch out for.** The routes still do not exist on the running application — `AppModule` does not import
this module, so `pnpm dev:api` will 404 on both paths. That one-line edit is step 26, kept separate
because it is the moment public webhook endpoints switch on, which deserves its own review rather than
riding along here. **Resolved in step 26.**

#### `apps/api/src/app.module.ts` — TelephonyModule imported

**Step 26** · 2026-07-31

**What it does.** Adds `TelephonyModule` to the root module's imports. One line of code; the moment the
public webhook endpoints exist on the running application.

**Why it's written this way.**

- **Kept as its own step, deliberately.** Mechanically it is trivial, but it is the transition from
  "code that compiles" to "two unauthenticated, publicly reachable endpoints on a running server". That
  is worth a review boundary of its own rather than riding along inside step 25.
- **The comment states what the import means, not what it does.** `imports: [TelephonyModule]` is
  self-evident; that it exposes routes whose only protection is `TwilioSignatureGuard` is not. Someone
  removing the guard later should meet that sentence first.
- **The worker loads this same graph and that is intentional.** `worker.ts` uses
  `createApplicationContext`, so controllers are instantiated but never routed and no port opens (D7).
  The telephony providers are needed there for job processing. Worth stating, because "the worker
  imports the module with the HTTP controllers" otherwise looks like a mistake.

**Connects to.** `telephony.module.ts`, `main.ts` (HTTP), `worker.ts` (context only).

**Verified end to end against the running server** — built, booted `node dist/main.js`, seeded a business
and an `ACTIVE` phone number, and posted requests signed exactly as Twilio signs them:

| Request                     | Result                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Routes at boot              | `Mapped {/webhooks/twilio/voice/incoming, POST}` and `.../status, POST` ✓           |
| Unsigned POST               | `403` ✓                                                                             |
| Signed POST                 | `200`, `content-type: text/xml`, TwiML naming **E2E Cleaning Co** ✓                 |
| Signed retry (same payload) | `200`, identical TwiML, **no second row** ✓                                         |
| Signed status callback      | `204` ✓                                                                             |
| Database after 3 deliveries | 2 rows — `voice.incoming` **PROCESSED, tenant resolved**; `voice.status` RECEIVED ✓ |

This is the first time the whole chain has run as it will in production: HTTP → signature validation →
idempotent persistence → tenant resolution from `To` → TwiML. All test data was removed afterwards.

**Watch out for — a local `.env` change was required.** `TWILIO_AUTH_TOKEN` was empty, and the guard
correctly refuses **all** webhook traffic when it is unset, so nothing could be exercised. It is now
`local_test_token_for_e2e` in the local `.env` (gitignored, never committed). Replace it with the real
auth token from the Twilio console when the account is provisioned — until then, signatures only
validate against payloads signed with this placeholder.

Second: the endpoints are now live whenever the API runs. On a laptop that is harmless, but the moment
this is deployed they are internet-reachable. Before that happens, `PUBLIC_API_URL` must match the
deployed URL exactly or every signature fails (step 20), and the Twilio console webhook URLs must point
at the same host (`docs/twilio-setup.md` §5).

#### `apps/api/prisma/schema.prisma` — `customers` and `calls` added

**Step 27** · 2026-08-01

**What it does.** Adds `Customer` and `Call`, plus three enums (`LineType`, `CallOutcome`,
`NoRecoveryReason`). Two tables in one step because a `Call` without a `Customer` has nowhere to point,
and a `Customer` with no calls is an empty concept — splitting them would have produced a migration that
could not be exercised.

**Why it's written this way.**

- **A call is not a lead (D5), and the schema enforces it.** `Call` has no lead relation and no lead
  fields. Leads arrive later, created lazily on the customer's _first reply_. This is what keeps the
  owner's inbox free of spam callers and non-responders, and it is what makes "% of missed callers who
  became qualified leads" a computable number rather than an estimate.
- **`NoRecoveryReason` is the most valuable column here.** Every value is a real, frequent case that
  costs money or trust if mishandled: withheld caller ID, a landline that would fail and bill us anyway,
  an opt-out, a repeat caller inside the throttle window, staff ringing in, a spend cap, or the owner
  simply answering. Storing _why_ no text was sent means "why did this caller never hear from us?" is
  answerable months later — and it separates "we chose not to text" from "we failed to text", which is
  the difference between a working product and a broken one in the pilot metrics.
- **`customerId` is nullable, and `onDelete: SetNull`.** A withheld caller ID produces a real call with
  nobody to attribute it to. And if a customer is later deleted — an APP 12/13 erasure request
  (`docs/compliance.md` §4) — the call still happened; erasing the person must not erase the business's
  own record of its call volume.
- **`@@unique([businessId, phoneE164])`, not a global unique on the phone.** The same person calling two
  cleaning companies is two customers. A global unique would silently merge two businesses' customer
  records, which is a tenancy breach dressed as deduplication.
- **`LineType.UNKNOWN` is distinct from a null.** It means _not yet looked up_, which is different from
  "looked up and unusable". Lookup costs ~US$0.008 a call and the result is cached here so the same
  number is never paid for twice.
- **`providerCallSid @unique`.** One row per call however many webhooks it emits — the `Call` table's
  own idempotency, independent of `webhook_events`.
- **`forwardedFromE164` is stored despite being unreliable.** It is inconsistently populated on AU PSTN
  and must never be depended on, but it is direct evidence for the D13 question of what carriers
  actually pass through on a forwarded leg. Every real call becomes a data point.
- **`durationSeconds` is our leg only** — the greeting, not how long the caller waited before the
  carrier forwarded. Worth stating, because it is the obvious thing to misread when the number looks
  implausibly small.

**Connects to.** `phone_numbers` (resolves which business a call belongs to). `tenant-guard.ts` — both
models were already in `TENANT_MODELS`, so they arrived guarded. D5, D8. Migration
`20260801061653_add_customers_and_calls`.

**Verified against the live database, 14/14.** Both models are guarded (`findMany({})` throws). The same
number is a distinct customer per business; a duplicate within one business is rejected. `lineType`
defaults to `UNKNOWN` with a null timestamp. A duplicate `CallSid` is rejected. A withheld-caller-ID call
records with `customerId: null` and `noRecoveryReason: ANONYMOUS_CALLER`. Deleting a customer leaves the
call intact with a null `customerId`. The "which calls never got a text, and why" query works. Deleting a
business cascades to both tables.

**Watch out for — the guard rejected the verification script, correctly.** `customer.delete({ where: { id } })`
threw `TenantScopeError`. That is the D8 design working: a bare-id delete cannot express a tenant
constraint, so a stolen or guessed id would delete another business's row. The scoped form is
`deleteMany({ where: { businessId, id } })`. Expect this friction whenever a service does a
delete-by-id — it is the guard doing its job, not an obstacle to route around with `unscoped`.

Second: `Call.outcome` defaults to `IN_PROGRESS`, but the voice webhook currently records nothing into
this table at all — it only writes `webhook_events`. Nothing populates `calls` yet. The service that
turns a recorded webhook into a `Call` is the next step, and until it exists these tables stay empty on
a running system. **The service landed in step 28; the controller still does not call it.**

---

### API — calls

#### `apps/api/src/calls/calls.service.ts`

**Step 28** · 2026-08-01

**What it does.** Turns a recorded voice webhook into a `Call` (creating or reusing a `Customer`), and
decides whether that caller should get a recovery SMS — returning either `shouldRecover: true` or a
`NoRecoveryReason`. Also applies status callbacks to an existing call.

**Why it's written this way.**

- **The decision is the product, so it is a pure ordered sequence of guards with a reason attached to
  each.** Texting the wrong person is expensive in three different currencies: a landline send fails and
  still bills us, an opt-out breaches the Spam Act, and a qualification question to your own plumber
  mid-job is a trust cost. Making each skip an enum value rather than an early `return false` is what
  keeps "why did this caller never hear from us?" answerable months later.
- **The check order is deliberate, not cosmetic.** `ANONYMOUS_CALLER` needs no query at all, so a
  withheld number never causes a database round trip. `CAP_REACHED` (the kill switch) comes before
  anything caller-specific, because a global stop should not depend on per-caller lookups. The two
  counting queries are last, cheapest-first.
- **Replay returns the original decision rather than re-deciding — the subtlest thing here.** A retried
  webhook that re-ran the decision would see the _first_ attempt's `recoverySmsQueuedAt` in the throttle
  window and skip, silently converting a transient retry into a permanent `RECENTLY_CONTACTED`. The
  early return on an existing `providerCallSid` is what prevents a duplicate delivery from suppressing
  the very message it is retrying.
- **`recoverySmsQueuedAt` is set at decision time, not on delivery.** It marks _the decision_, and the
  message's own status lives on `messages`. That means a crash between deciding and enqueuing cannot
  produce a second text on retry — the throttle window already knows.
- **The throttle counts calls we queued a text for, not calls received.** Three rings in five minutes is
  one conversation, and that is exactly what someone does when they need a cleaner today.
- **`upsert`, not find-then-create.** Two calls from the same number can arrive concurrently and the
  unique index would reject the loser. `update: {}` touches nothing — a call is not new information
  about a customer, and blindly writing would risk overwriting a learned name with nothing.
- **`UNKNOWN` line type is allowed through.** Lookup runs in the worker before the send, so this is not
  the last line of defence; blocking here would mean never texting anyone we have not already paid to
  look up.
- **Terminal outcomes are never walked backwards.** Status callbacks arrive out of order, so a late
  `ringing` after `completed` is ignored rather than regressing the call.
- **An unrecognised `CallStatus` warns and falls back** instead of throwing. A new Twilio status must not
  break call recording, but it should be noticed.

**Connects to.** `prisma/schema.prisma` (`Call`, `Customer`, `NoRecoveryReason`). `config/env.ts`
(`SENDING_ENABLED`, `MAX_SMS_PER_BUSINESS_PER_DAY` — the circuit breakers from the queues skill §9).
Will be called by `voice.controller.ts` and read by the recovery job.

**Verified against the live database, 18/18.** A normal missed call recovers with
`recoverySmsQueuedAt` set. A repeat caller inside 24h → `RECENTLY_CONTACTED`, reusing the same customer.
Withheld → `ANONYMOUS_CALLER` with a null `customerId`. Landline → `NOT_TEXTABLE`. Staff →
`KNOWN_CONTACT`. **Replaying a `CallSid` returns the same row and preserves the original decision rather
than re-throttling.** The same caller at a _different_ business is not throttled — tenant isolation holds
in the decision path, not just in queries. `completed` applies duration and `endedAt`; a late `ringing`
does not overwrite it. An unknown status falls back without throwing; `applyStatus` on an unknown call
returns null.

**Watch out for.** `SUPPRESSED` is defined in `NoRecoveryReason` but **is never returned** — the
`suppressions` table does not exist yet. Opt-outs are therefore not enforced in this decision path. That
is the single most important gap in this file: sending to someone who replied STOP is a Spam Act breach,
and nothing here currently prevents it. The check belongs in `decideRecovery`, immediately after the
kill switch, when the table lands.

Second: the per-business cap counts a rolling 24 hours, not a calendar day in the business's timezone.
For a spend guardrail that is arguably better — it cannot be reset by midnight — but it does not match
what an owner would mean by "200 a day", so the wording in any future settings UI needs care.

#### `apps/api/prisma/schema.prisma` — `suppressions` added

**Step 29** · 2026-08-01

**What it does.** Adds `Suppression` and `SuppressionReason`. One table answering one question — "may we
send to this number?" — for four different reasons: an opt-out, a non-textable line, an owner blocklist
entry, and staff.

**Why it's written this way.**

- **One table, not three.** Opt-outs, the blocklist and cached landline results are separate concerns
  that all get consulted at the same instant, on the same hot path. Three tables would mean three
  lookups before every send and three chances to forget one — and the one you forget is the one that
  breaches the Spam Act.
- **`@@unique([businessId, phoneE164])` — suppression is per sender, not global.** This mirrors how the
  Spam Act treats consent: a number that opted out of one business's messages has said nothing about
  another's. Getting this wrong is a bug in _both_ directions — global suppression silently loses a
  different business's leads, while no suppression breaches. Both directions are tested.
- **The unique constraint has a consequence worth stating: one reason per number per business.** A
  number blocked as `SPAM` that later replies STOP cannot hold both. `OPTED_OUT` must win, because it is
  the only one with legal weight — that precedence belongs in the service's upsert, and is noted in the
  schema so it is not discovered later.
- **`sourceMessageSid` is a plain string, deliberately not a foreign key.** It is evidence that an
  opt-out was honoured and when. `messages` does not exist yet, and more importantly this must **outlive**
  the 90-day retention sweep that will eventually delete the message itself. A foreign key would either
  block that deletion or cascade away the evidence.
- **Opt-out rows are never bulk-deleted.** Honouring an opt-out means keeping the record of it, which
  makes this table a deliberate exception to data minimisation (`docs/compliance.md` §7). Stated in the
  model doc so nobody "cleans up old suppressions" and silently re-enables messaging to people who said
  stop.
- **The doc comment records the Twilio 21610 divergence.** Twilio keeps its own opt-out list per sending
  number and rejects sends even when our database thinks a number is fine. The worker must back-fill a
  row on 21610 — noted here because that is where someone will look when a send mysteriously fails.

**Connects to.** `calls.service.ts` — this table is what `NoRecoveryReason.SUPPRESSED` needs, and closes
the gap flagged in step 28. `.claude/skills/twilio/SKILL.md` §5 (opt-out, 21610).
`docs/compliance.md` §1 and §7. Migration `20260801072010_add_suppressions`.

**Verified against the live database, 9/9.** Guarded by the tenant extension. An opt-out stores with its
evidence SID. **The same number is suppressed at business A and not at B**, and can be suppressed at B
independently under a different reason. A duplicate `(business, phone)` is rejected. All four reasons
round-trip. Business deletion cascades.

**Index usage was measured, not assumed** — 500 rows, `EXPLAIN` on both real query shapes:

| Query                                 | Plan                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Hot path: `(business_id, phone_e164)` | `Index Only Scan using suppressions_business_id_phone_e164_key` — no heap access at all |
| Dashboard: `(business_id, reason)`    | `Index Scan using suppressions_business_id_phone_e164_reason_idx`                       |

Both indexes earn their place, and the hot path is an _index-only_ scan — the send guard never touches
the table itself. Worth checking rather than assuming: the composite index has `phone_e164` in the
middle, so it was not obvious it would serve a `(business_id, reason)` filter, and it does.

**Watch out for.** The table exists; **nothing reads it yet**. `calls.service.ts` still never returns
`SUPPRESSED`, so an opt-out is recorded and then ignored. The gap flagged in step 28 is now _closable_,
not closed — the check must be added to `decideRecovery` immediately after the kill switch. Until then
the compliance exposure is unchanged.

Second: `NOT_TEXTABLE` is duplicated between here and `Customer.lineType`. That is intentional — the
customer row caches what Lookup said, while a suppression row is the decision not to send — but two
places holding the same fact can disagree. The service that writes both must keep them consistent, and
`suppressions` is the one the send path trusts.

#### `apps/api/src/calls/suppressions.service.ts`

**Step 30** · 2026-08-01

**What it does.** Owns "may we send to this number?". `isSuppressed` is the hot-path read; `suppress`
applies reason precedence; `optOut` / `optIn` handle the Spam Act path; `classifyKeyword` decides whether
an inbound message is a STOP; `block` and `markNotTextable` are the operational entry points.

**Why it's written this way.**

- **`classifyKeyword` matches the whole message, not a substring — the trap in this file.** A caller
  writing _"please stop by tomorrow"_ or _"can you stop the carpet clean?"_ must not be opted out. A
  naive `body.includes('stop')` silently loses a customer mid-conversation and, worse, looks like
  correct compliance behaviour while doing it. Exact match after trimming and stripping trailing
  punctuation, which is also how Twilio behaves. Both phrasings are in the test set.
- **`isSuppressed` returns the _reason_, not a boolean.** The caller has to record _why_ it skipped
  (`NoRecoveryReason`), and a boolean would force either a second query or an unexplained no-op in the
  logs.
- **Deliberately not cached.** An opt-out must take effect on the very next send. A stale cache entry
  here is a compliance breach, not a performance regression — and step 29 measured this as an
  index-only scan, so there is nothing to optimise.
- **Precedence exists because the table holds one row per (business, phone).** A number blocked as
  `SPAM` that later replies STOP has to resolve to something. `OPTED_OUT` outranks everything: it is the
  only reason with legal weight and the only one that may never be silently discarded. Lower-priority
  writes still record their note and evidence, so the fact that they _also_ opted out is not lost.
- **`optIn` only deletes `OPTED_OUT` rows.** A `START` says nothing about a landline or an owner's
  blocklist entry. Clearing everything would let a blocked marketer text their way back in — tested
  explicitly.
- **`optOut` logs at `warn`.** An opt-out is not an error, but a rising rate is the clearest early signal
  that the messaging is landing badly, and it should be visible without going looking for it.

**Connects to.** `prisma/schema.prisma` (`Suppression`, step 29). `calls.service.ts` — `isSuppressed` is
what `NoRecoveryReason.SUPPRESSED` needs. `.claude/skills/twilio/SKILL.md` §5 (STOP keywords, error
21610). `docs/compliance.md` §1.

**Verified against the live database, 15/15.** 14 keyword cases including both false-positive phrasings.
`SPAM` and `NOT_TEXTABLE` do **not** downgrade an existing `OPTED_OUT`, and the opt-out's evidence SID
survives those writes. A STOP **does** upgrade an existing `SPAM`. `optIn` clears an opt-out but leaves a
blocklist entry intact. A repeated STOP creates no second row. Opt-out is per business — the same number
is suppressed at A and sendable at B. `listForBusiness` filters and orders correctly.

**Watch out for — the wiring is still not done.** This service exists and works, but
`calls.service.ts` does not call it. `decideRecovery` still never returns `SUPPRESSED`, so an opt-out is
recorded and then ignored on the next call from that number. That is one line plus a constructor
dependency, and it is step 31. **Until it lands, the compliance gap opened at step 28 remains open** —
the mechanism is built, not connected.

Second: `START` is treated as a resubscribe, and `YES` is included in that set. `YES` is plausible as a
genuine conversational reply ("yes, 2 bedrooms") — it is harmless today because it only _removes_ a
suppression that must already exist, but if the keyword set is ever reused for anything else, `YES`
should be reconsidered.

**Correction (step 31).** The verified claim above — "`optIn` clears an opt-out but leaves a blocklist
entry intact" — is **true only when the number was never upgraded**. The step 30 test covered a number
that was _only_ blocked. It does not hold for `block → STOP → START`, because the precedence upgrade
overwrites `reason` **in place**: the row becomes `OPTED_OUT`, `optIn` deletes rows whose reason is
`OPTED_OUT`, and the original `SPAM` block is destroyed with it. See step 31 for the full finding and the
fix. The docstring on `optIn` currently overstates what the method guarantees.

#### `apps/api/src/calls/calls.service.ts` — suppression check wired

**Step 31** · 2026-08-01

**What it does.** Injects `SuppressionsService` and adds one check to `decideRecovery`. **This closes the
Spam Act gap opened at step 28** — an opt-out now actually prevents the next recovery SMS.

**Why it's written this way.**

- **The check sits immediately after the kill switch and before every other caller-specific test.** It is
  the only skip reason with legal weight; nothing else should be able to shortcut past it. The kill
  switch stays first because a global stop must not depend on a per-caller query.
- **One lookup covers three concerns** — opt-out, owner blocklist, cached non-textable — which is the
  payoff for the single-table design chosen at step 29.
- **A `NOT_TEXTABLE` suppression maps back to `NOT_TEXTABLE`, not `SUPPRESSED`.** The two are
  operationally identical (do not send) but mean different things in the pilot metrics: "this line
  cannot receive SMS" is a technical fact, while `SUPPRESSED` is a person or an owner saying no. Merging
  them would corrupt the denominator of the recovery-rate figure the pilot rests on.

**Connects to.** `suppressions.service.ts` (step 30), `calls.service.ts` (step 28),
`docs/compliance.md` §1.

**Verified against the live database, 8/10 — and both failures were informative.**

Confirmed working: a caller who opts out and rings again gets `SUPPRESSED` with no recovery queued and
the reason persisted on the call row; the same number is still recoverable at a _different_ business; an
owner blocklist entry yields `SUPPRESSED`; a cached landline yields `NOT_TEXTABLE`.

**Failure 1 was the test, not the code.** After `optIn`, the caller was reported as
`RECENTLY_CONTACTED` rather than recoverable. That is correct — the same caller had a _recovered_ call
minutes earlier, so the 24-hour throttle applied. Diagnosed directly: the suppression row was gone
(`isSuppressed → null`), so the opt-in worked exactly as intended.

**Failure 2 is a real bug, in step 30's code, found only because this step exercised the two services
together.**

```
block(SPAM)  →  isSuppressed = SPAM
optOut()     →  isSuppressed = OPTED_OUT     (precedence upgrade, overwrites `reason` in place)
optIn()      →  isSuppressed = null          (row deleted entirely — the SPAM block is gone)
```

`optIn` deletes rows whose reason is `OPTED_OUT`. Because the upgrade **overwrote** the reason rather
than layering on top of it, the original blocklist entry no longer exists to survive the delete. A
blocked marketer can therefore text `STOP` then `START` and become contactable again — precisely the
behaviour `optIn`'s docstring says it prevents.

Severity, honestly: this fails in the _safe_ direction for compliance — opt-outs are still honoured, so
there is no Spam Act exposure. The cost is money and owner trust, and it needs an unusual sequence. But
it contradicts documented behaviour, so it is a bug rather than a quirk.

**The fix is a schema change and is step 32:** separate the legal fact from the operational one with an
`optedOutAt DateTime?` column. `reason` then stays operational (`SPAM` / `STAFF` / `NOT_TEXTABLE`),
`optedOutAt` records the opt-out independently, `isSuppressed` returns `OPTED_OUT` whenever `optedOutAt`
is set, and `optIn` clears the timestamp instead of deleting the row — so an underlying block survives.
That also removes the single-reason limitation noted in step 29.

**Watch out for.** Nothing calls `recordInboundCall` yet — `voice.controller.ts` still only writes
`webhook_events`. The decision logic is complete and correct, but on a running system no `Call` rows are
created and therefore no suppression check ever executes. The controller wiring is still outstanding.

#### `apps/api/prisma/schema.prisma` — `optedOutAt` added, `OPTED_OUT` removed from the enum

**Step 32** · 2026-08-01

**What it does.** Fixes the step 31 bug at its root. `SuppressionReason` loses `OPTED_OUT` and keeps only
the three operational values; `reason` becomes nullable; a new `optedOutAt DateTime?` records the legal
fact independently.

**Why it's written this way.**

- **The bug was a modelling error, not a logic error, so the fix belongs in the schema.** An opt-out and
  an owner's block are _different kinds of fact_ that happen to have the same effect. Forcing them into
  one enum column meant recording the second destroyed the first, and no amount of care in the service
  could recover information the column could not hold.
- **`reason` is nullable, with the invariant stated in the comment:** at least one of `reason` and
  `optedOutAt` is always set. A row with neither would suppress a number for no recorded cause, which is
  worse than not suppressing it.
- **Two new indexes replace one.** `(businessId, reason)` serves the dashboard's "show me everything
  blocked as SPAM"; `(businessId, optedOutAt)` serves "show me every opt-out, newest first" — a
  compliance query that had no index at all before, because opt-outs were previously indistinguishable
  from other reasons. The old three-column index is dropped: with `reason` no longer carrying the
  opt-out, it no longer answers either question.
- **The hot-path unique index is untouched**, so the index-only scan measured at step 29 still holds.

**Connects to.** Fixes the defect recorded in step 31. `suppressions.service.ts` must now change to
match (step 33). Migration `20260801080000_split_optout_from_reason`.

**Migration applied and verified.** The database now has `opted_out_at`, a nullable `reason`, the
three-value enum, and both new indexes. Confirmed with `\d suppressions`.

**Watch out for — two real toolchain findings.**

1. **`prisma migrate dev` cannot run non-interactively when a change is destructive.** Removing an enum
   value triggers a `(y/N)` confirmation, and with no TTY the command aborts with
   _"Prisma Migrate has detected that the environment is non-interactive"_. `--create-only` aborts the
   same way, and piping `y` through `script` did not forward stdin. **The working route is
   `prisma migrate diff --from-config-datasource --to-schema ./prisma/schema.prisma --script`** to
   generate the SQL into a hand-named migration directory, then `prisma migrate deploy` to apply it —
   `deploy` is non-interactive by design. Note the Prisma 7 flag names: `--to-schema`, not
   `--to-schema-datamodel`, and there is no `--shadow-database-url` on `migrate diff`.
2. **`prisma generate` succeeded while the migration had failed**, leaving the generated client
   describing a schema the database did not have. Nothing warned. If a migration aborts, re-check
   `migrate status` before trusting the client — a generate that "worked" is not evidence the database
   moved.

**Watch out for — the build is RED at the end of this step.** `pnpm typecheck` reports exactly 4 errors,
all in `suppressions.service.ts`, all caused by `'OPTED_OUT'` no longer being a `SuppressionReason`:
the `REASON_PRECEDENCE` key, an index into it that can now be null, the literal in `optOut`, and the
`deleteMany` filter in `optIn`. `calls.service.ts` still compiles — its `'SUPPRESSED'` is a
`NoRecoveryReason` and is unaffected.

This is the one-file protocol's intended trade: schema and service are a single logical change whose
intermediate state does not compile. It is recorded here rather than hidden, and **step 33 restores
green**. Do not deploy from this commit. **Resolved in step 33 — 0 errors.**

#### `apps/api/src/calls/suppressions.service.ts` (rewritten)

**Step 33** · 2026-08-01

**What it does.** Rewrites the service against the two-column model from step 32. Restores the build to
green and fixes the step 31 defect.

**Why it's written this way.**

- **`REASON_PRECEDENCE` is gone entirely.** That table existed only to arbitrate between two facts
  competing for one column. With `optedOutAt` and `reason` orthogonal, writing one cannot destroy the
  other, so there is nothing left to arbitrate — the fix _removed_ code rather than adding a special
  case on top of a flawed model. Worth noticing: a bug fix that deletes the mechanism that caused it is
  usually the right shape.
- **`isSuppressed` reports `OPTED_OUT` ahead of any operational reason**, via a new `SuppressionStatus`
  type — `SuppressionReason | 'OPTED_OUT'`. Precedence survives where it belongs, in _reporting_: the
  opt-out is the answer that matters legally and the one an owner needs to see. It no longer touches
  storage.
- **`optOut` preserves the original `optedOutAt` on a repeat STOP.** The date that matters for a
  compliance record is when they _first_ said stop, not when they last repeated it. `existing.optedOutAt
?? new Date()` is a one-line detail with real consequences in a dispute.
- **`optOut` writes `reason: null` for a fresh row.** The row exists purely because of the opt-out and
  claims no operational block — which is exactly the state that used to be unrepresentable.
- **`optIn` deletes the row only when `reason` is null.** Otherwise it clears the timestamp and leaves
  the block. An empty row would suppress nothing while looking like it suppressed something.
- **`optIn` keeps `sourceMessageSid`.** It is evidence that an opt-out happened; a later opt-in does not
  make that untrue, and the audit trail should outlive the state change.
- **`listOptOuts` is new** — the compliance view, backed by the `(businessId, optedOutAt)` index added in
  step 32. It could not exist before, because opt-outs were indistinguishable from other reasons.

**Connects to.** `prisma/schema.prisma` (step 32). `calls.service.ts` — unchanged, and still compiles:
it consumes the returned status without caring how it is stored.

**Verified against the live database, 18/18 — including the exact step 31 scenario.**

```
block(SPAM)  →  SPAM         row: reason=SPAM,  optedOutAt=null
optOut()     →  OPTED_OUT    row: reason=SPAM,  optedOutAt=<t>   ← block survives underneath
optIn()      →  SPAM         row: reason=SPAM,  optedOutAt=null  ← FIXED
```

Also confirmed: the reverse order (opt-out first, then block) holds both facts simultaneously and still
reports `OPTED_OUT`; a repeat STOP keeps the original timestamp; an opt-out-only row is deleted on
opt-in because nothing is left to record; opt-out evidence survives opt-in; per-business isolation holds;
whole-message keyword matching is unchanged; and end to end through `CallsService`, an opted-out caller
yields `SUPPRESSED` while a landline still yields the distinct `NOT_TEXTABLE`.

**Watch out for.** `isSuppressed` now returns `SuppressionStatus`, a wider type than
`SuppressionReason`. Anything that switches exhaustively on the result must handle `'OPTED_OUT'`, which
is not a database value. `calls.service.ts` already does, via its `=== 'NOT_TEXTABLE'` check falling
through to `SUPPRESSED`.

Second: the schema invariant "at least one of `reason` and `optedOutAt` is set" is enforced by this
service, not by the database. A `CHECK` constraint would make it structural. Worth adding if anything
else ever writes to this table.

#### `apps/api/src/calls/calls.module.ts`

**Step 34** · 2026-08-01

**What it does.** Registers `CallsService` and `SuppressionsService` and exports both.

**Why it's written this way.**

- **No controllers.** Calls arrive through Twilio webhooks, which belong to `TelephonyModule`. This
  module owns what happens _after_ a webhook is authenticated and recorded. A dashboard call list will
  add a controller later; there is nothing to expose yet.
- **`SuppressionsService` lives here rather than in its own module.** It exists to answer one question —
  "may we send to this caller?" — which is a step in the recovery decision. A separate module whose only
  consumer is this one would be ceremony.
- **Both are exported.** `TelephonyModule` needs `CallsService`; the messaging path will need
  `SuppressionsService` directly, to record a STOP reply and to check before every send.

**Connects to.** `calls.service.ts`, `suppressions.service.ts`, `prisma.module.ts` (global). Will be
imported by `TelephonyModule` and later by the messaging module.

**Verified 7/7 — but only after the verification method itself had to be fixed.** Mounted with _only_
`PrismaModule`, proving it stands alone: both services resolve, `PrismaService` is reachable through the
global module without being imported, `CallsService` receives a **real** `SuppressionsService` instance
(not a stub), an opted-out caller yields `SUPPRESSED` through container-wired instances, and both
services are visible to a downstream consumer module.

**Watch out for — a finding that invalidates a verification technique used since step 27.**

**`tsx` cannot run NestJS dependency injection.** tsx compiles with esbuild, and **esbuild does not
support `emitDecoratorMetadata`**. Without `design:paramtypes`, Nest cannot see a constructor's
parameter types, so it injects **nothing** — and, critically, does not error. Providers are constructed
with `undefined` dependencies and fail later at first use:

```
TypeError: Cannot read properties of undefined (reading 'db')
    at SuppressionsService.optOut (suppressions.service.ts:119)
```

The identical probe compiled with `nest build` (tsc) passes 7/7. Earlier verification scripts were
unaffected because they constructed services by hand — `new CallsService(prisma, suppressions)` — which
bypasses DI entirely. **Any future check of DI wiring must run against `dist/`, not through tsx.**

**Second, and more serious: this affects `pnpm dev:worker`.** The script is
`tsx watch src/worker.ts`, so the worker's entire object graph is built without decorator metadata.
It _appears_ to start correctly — the boot log shows every module initialising and "Worker started" —
because nothing dereferences an injected dependency at boot. The failure surfaces only when a job
processor actually runs, as an `undefined` property error far from its cause.

Nothing is broken today: `worker.ts` currently only creates a context and logs. But the first BullMQ
processor with an injected service would hit this, and the symptom would look like a bug in the
processor rather than in the dev script.

**Verified fix:** `nest start --entryFile worker` boots the same graph through tsc with metadata intact
(confirmed working). The `dev:worker` script should change to that, plus `--watch`. That is a
`package.json` edit and is the next step.

`pnpm dev:api` is unaffected — it already uses `nest start --watch`. **Fixed in step 35.**

#### `apps/api/package.json` — `dev:worker` moved off tsx

**Step 35** · 2026-08-02

**What it does.** Changes one script:

```diff
- "dev:worker": "tsx watch src/worker.ts",
+ "dev:worker": "nest start --watch --entryFile worker",
```

**Why it's written this way.**

- **It removes a trap rather than fixing a visible failure.** Nothing was broken — the old script
  started cleanly and printed a healthy boot log. It would have failed on the _first BullMQ processor
  that used an injected service_, as an `undefined` property error inside the processor, days after the
  cause was introduced and nowhere near it. Fixing it before writing that processor is the difference
  between a non-event and a wasted afternoon.
- **`nest start --entryFile worker` compiles with tsc**, so `emitDecoratorMetadata` is applied and
  `design:paramtypes` exists for Nest to read. It also matches `dev` exactly, which means the two
  entrypoints now share one toolchain — consistent with D7's "same modules, same image, different start
  command".
- **`tsx` stays in devDependencies deliberately.** It is genuinely useful for one-off scripts that
  construct objects directly, which is how most verification in this build has been done. The limitation
  is documented at step 34 rather than removing a useful tool.

**Connects to.** `src/worker.ts` (the entrypoint), `nest-cli.json` (supplies the compiler options),
step 34 (which found the problem).

**Verified.** `pnpm dev:worker` now compiles in watch mode — _"Found 0 errors. Watching for file
changes."_ — then boots the full graph: `PrismaModule`, `AppModule`, `TelephonyModule` all initialise
and `Database connected (tenant guard active)` appears. The same graph under tsx built its providers
with `undefined` dependencies.

**Watch out for.** `nest start --watch` recompiles the whole project on change, so it is slower to
restart than tsx was. That is the cost of correct DI and is not negotiable — a faster dev loop that
silently injects `undefined` is not a faster dev loop.

Second: the Nest CLI spawns a child process that survives a signal sent to the parent. When stopping a
watch-mode worker from a script, `pkill -f 'nest.js start'` is needed; killing the shell that launched it
leaves the compiler and the app running.

#### `apps/api/src/telephony/telephony.module.ts` — imports `CallsModule`

**Step 36** · 2026-08-02

**What it does.** Adds `imports: [CallsModule]`, making `CallsService` injectable into
`VoiceController`.

**Why it's written this way.**

- **The dependency points telephony → calls, not the reverse, and that direction is the design.**
  `CallsService` knows nothing about Twilio: it takes already-normalised values and returns a decision.
  That is what let steps 28–33 verify the entire recovery decision — throttling, suppression, precedence
  — without constructing a single webhook. If the arrow were reversed, every test of the decision would
  need a signed Twilio payload.
- **Only the import changes.** `TelephonyModule` still exports just `WebhookEventsService`; it does not
  re-export `CallsService`, because a module should not become a pass-through for its own dependencies.
  Anything needing `CallsService` imports `CallsModule` directly.

**Connects to.** `calls.module.ts` (step 34), `voice.controller.ts` (which can now inject it, step 37).

**Verified 7/7 through compiled output** — following the step 34 lesson that tsx cannot exercise Nest DI:

- `CallsService` resolves **from `TelephonyModule`'s own scope**, not merely from the root container.
  This is the assertion that actually tests the import; `app.get(CallsService)` would have passed even
  without it, because the root container sees every provider in the graph.
- `SuppressionsService` is reachable transitively, since `CallsModule` exports it.
- `WebhookEventsService` and `VoiceController` still resolve — the import broke nothing.
- **The same `CallsService` instance is shared**, not duplicated per importing module. Worth asserting
  explicitly: two instances would mean two independent 24-hour throttle counters, and a caller could be
  texted twice for one call.
- `CallsService` has a real `SuppressionsService` injected, so the wiring is live end to end.

**Watch out for.** The controller still does not call it. `CallsService` is now _available_ to
`VoiceController` — nothing more. On a running system a forwarded call is still authenticated, recorded
in `webhook_events`, and answered, with no `Call` row and no recovery decision. Step 37 is the line of
code that closes it. **Done in step 37.**

#### `apps/api/src/telephony/voice.controller.ts` — wired to `CallsService`

**Step 37** · 2026-08-02

**What it does.** `/incoming` now calls `recordInboundCall`, creating a `Call` and a `Customer` and
recording the recovery decision. `/status` now calls `applyStatus`, so a call's outcome and duration are
recorded rather than only its arrival. **This closes the loop that has been open since step 28.**

**Why it's written this way.**

- **The withheld-caller-ID branch was removed, not kept.** The controller no longer inspects `from`
  before deciding — it passes the null through and lets `CallsService` return `ANONYMOUS_CALLER`.
  Branching in both places would put two different answers to "why didn't we text?" in two files, and
  the enum exists precisely so there is one.
- **`toE164: number.e164`, not the inbound `To`.** Both normalise to the same value — the row was found
  by it — but the stored one is canonical by construction and needs no fallback for unparseable input.
  This was forced by `noUncheckedIndexedAccess` flagging `body.To` as `string | undefined`, and the
  compiler's objection led to the better expression.
- **`/status` applies the outcome even for a duplicate delivery.** `applyStatus` is idempotent and
  refuses to overwrite a terminal outcome, so a replay cannot walk a completed call backwards. Skipping
  the update on a duplicate would instead mean a retried callback never lands at all.
- **`CallDuration` is parsed defensively.** A missing or non-numeric value yields `undefined` rather
  than `NaN` — which would otherwise be written into an `Int` column.
- **The enqueue is still a marked gap**, now on the `shouldRecover` branch with a log line. The call is
  already stamped `recoverySmsQueuedAt`, so the decision survives a crash between here and the enqueue —
  the throttle window will not re-decide on a retry.

**Connects to.** `calls.service.ts` (the decision), `webhook-events.service.ts` (idempotency),
`telephony.module.ts` (supplies the dependency), `common/phone.ts` (`toE164` at the edge).

**Verified end to end against a running server, 7/7.** Signed webhooks posted with `curl`, exactly as
Twilio sends them:

| Scenario                          | `Call` row written                                                          |
| --------------------------------- | --------------------------------------------------------------------------- |
| Normal missed call                | `outcome=COMPLETED`, `recoverySmsQueuedAt` set, no reason, customer created |
| Opted-out caller                  | `noRecoveryReason=SUPPRESSED`, **not** queued                               |
| Withheld caller ID                | `noRecoveryReason=ANONYMOUS_CALLER`, `customerId=null`                      |
| Status callback (`completed`, 9s) | `outcome=COMPLETED`, `durationSeconds=9`, `endedAt` set                     |

All three calls answered with valid TwiML and HTTP 200; the status callback returned 204. This is the
first time the full chain has run in one pass: **signature → idempotent record → tenant resolution →
call + customer → suppression check → recovery decision → TwiML.**

**Watch out for.** No SMS is sent, and that is now the _only_ thing missing from the recovery path. A
real caller today hears the greeting and receives nothing. The queue and the Twilio send are what remain.

Second: `/status` resolves the business by looking the `To` number up again, a second query per
callback. Fine at pilot volume and it keeps the handler stateless, but if status callbacks ever become
hot, the `Call` row already holds `businessId` and could be found by `providerCallSid` — that lookup is
`unscoped`, however, so it needs deliberate handling rather than a quiet swap.

---

### API — jobs

#### `apps/api/src/jobs/queues.ts`

**Step 38** · 2026-08-02

**What it does.** Queue names, typed job payloads, default job options, the Redis connection factory,
and `assertRedisDurability` — a boot-time check of the two Redis settings whose failure is silent.

**Why it's written this way.**

- **Names and payload types are colocated so a producer and consumer cannot disagree.** A typo in a
  queue name enqueues into a queue nobody reads, and _nothing errors_ — the job simply waits forever.
  One `QUEUE` constant and a `JobDataByQueue` map make that a compile error instead.
- **Five queues, one per side effect, not one shared queue.** Retry policy, rate limits and failure
  isolation are then tunable independently: SMS sends need a limiter to protect Twilio, LLM extraction
  needs low concurrency because it is slow and costly, and neither should stall the other. A single
  queue makes all three settings global.
- **Payloads carry IDs, never entities.** A serialised `Call` in Redis is a copy that goes stale the
  moment the row changes — and a delayed job may sit for hours. Re-reading in the processor also means
  it observes any state change made since the job was enqueued, which is what makes the
  `recoverySmsQueuedAt` check meaningful at send time.
- **`removeOnComplete` is treated as mandatory.** Without it Redis grows without bound until it hits
  maxmemory, where `noeviction` turns a slow leak into a hard stop. There is no separate dead-letter
  queue: `removeOnFail: { age: 604800 }` _is_ the dead letter, keeping a week of failures inspectable.
- **`assertRedisDurability` returns problems rather than throwing.** A misconfigured Redis is serious,
  but refusing to boot would take down a system that is otherwise serving calls correctly. The right
  response is a loud warning at startup, not a crash.

**Connects to.** `.claude/skills/queues-redis/SKILL.md` §1–4. `docker-compose.yml` (the settings it
asserts). `config/env.ts` (`REDIS_URL`). Will be consumed by the jobs module and `worker.ts`.

**Verified against real Redis, 13/13.** Defaults apply on enqueue (5 attempts, exponential backoff,
`removeOnComplete`); a typed payload round-trips; a delayed job lands in the delayed set; a worker with
its **own** connection drains the queue. Most usefully, `assertRedisDurability` was tested in both
directions — it passes against the compose config, **detects `allkeys-lru`**, and **detects both
problems at once** when `appendonly` is also turned off. A check that only ever passes proves nothing;
this one was made to fail on purpose and then restored.

**Watch out for — a documented pattern that does not work.** BullMQ 5 rejects a custom `jobId`
containing a colon:

```
Error: Custom Id cannot contain :
```

`:` is BullMQ's Redis key separator. The `queues-redis` skill recommended `recovery:${callSid}` and
`nudge:${conversationId}` — both would have thrown at the first enqueue. **Corrected to hyphens in the
same step**, since leaving it would have caused exactly this crash in whoever wrote the first producer.
Note the asymmetry: `webhook_events.dedupeKey` is a Postgres column and keeps its colons; only BullMQ
job ids are constrained.

Second: `assertRedisDurability` is written but **nothing calls it yet**. It belongs in the worker's
bootstrap, where a warning is visible at startup. Until then the check exists and never runs.
**Wired in step 39 — it now runs on every boot of both entrypoints.**

#### `apps/api/src/jobs/jobs.module.ts`

**Step 39** · 2026-08-02

**What it does.** Registers all five queues as injectable providers over one shared Redis connection,
runs the durability check at boot, and closes the connection on shutdown.

**Why it's written this way.**

- **`@Global()`, and this is the second and last one.** Producers live in almost every feature module —
  telephony enqueues recovery, conversations enqueue replies, leads enqueue owner notifications.
  Importing `JobsModule` in each would be noise that hides nothing. `PrismaModule` is the only other
  global; both are genuinely used everywhere, which is the bar.
- **Producers only. Processors belong to `worker.ts`.** The API and the worker load the same module
  graph (D7), so if this module registered `Worker` instances the API would start consuming its own
  jobs — sending SMS from inside the web process, which is exactly what the queue exists to prevent.
  The split is structural rather than a convention someone has to remember.
- **One connection for all producer queues, five separate ones for workers.** Producers only issue
  commands, so sharing is correct and avoids five sockets per process. A _worker_ connection blocks on
  `BRPOPLPUSH` and cannot also serve commands — sharing there deadlocks under load.
- **Queue providers are generated from the `QUEUE` constant**, so adding a queue is a one-line change in
  `queues.ts` and the provider appears automatically. A hand-written provider per queue is where the
  sixth one gets forgotten.
- **The durability check logs at `error`, not `warn`, when it fails** — but does not throw. The failure
  it guards is _invisible_: delayed jobs vanish on restart with no error anywhere. A loud line at
  startup is the entire point. Refusing to boot would take down an API that is still answering calls
  correctly, which trades a silent queue problem for a loud outage.
- **A failed `CONFIG GET` is caught separately and warns.** Managed Redis often forbids the command.
  That is not a fault in itself, but it means the settings are _unverified_ — saying so is more useful
  than silence, and materially different from "verified bad".

**Connects to.** `queues.ts` (topology, options, connection factory). `worker.ts` (will register
processors against these queue names). Every future producer injects `queueToken(QUEUE.X)`.

**Verified 8/8 through compiled output.** All five queues resolve as real `Queue` instances with names
matching the topology; they share exactly one connection; `DEFAULT_JOB_OPTIONS` reaches a job enqueued
through DI; the queues are reachable from a module that imports **nothing**, proving `@Global()` works;
and the connection is both closed and genuinely unusable after shutdown. The boot log now carries
`Redis durability OK (appendonly=yes, maxmemory-policy=noeviction)`.

**Watch out for — an assertion race worth knowing.** `ioredis` updates its `status` property a tick
_after_ `quit()` resolves. Asserting `conn.status === 'end'` immediately after `await app.close()` reads
`'ready'` and looks like the shutdown hook never ran. It did — a manual `quit()` afterwards fails with
"Connection is closed". Any test of connection teardown needs a tick, or should assert on behaviour
(`ping()` rejects) rather than on the status string.

Second: each Nest application context creates its **own** connection and its own queue instances. Two
contexts in one process — as in a test that boots twice — means two connections, and closing one does
not close the other. Fine in practice, but it makes leaked connections easy to create in tests.

#### `apps/api/src/common/gsm7.ts`

**Step 40** · 2026-08-02

**What it does.** Determines whether a message is GSM-7, counts billable segments, and throws with a
useful message when a template would silently cost more than it should. Makes `CLAUDE.md` rule 5
enforceable rather than aspirational — it has had **no enforcement at all** until now.

**Why it's written this way.**

- **The charset is an explicit `Set`, not a regex range.** GSM 03.38 is not contiguous in Unicode, so a
  range would quietly admit characters that are not in it — which is precisely the failure being
  prevented. Verbose, and correct.
- **Extended characters count as two septets.** `^ { } \ [ ~ ] | €` are reachable only via an escape
  sequence, so a message full of them hits the limit at half its apparent length. Verified: 80 euro
  signs is one segment, 81 is two.
- **`findNonGsm7` returns the characters, not a boolean.** The useful error is _which_ character.
  "contains ’ (U+2019)" tells someone what to fix; "not GSM-7" sends them hunting through a string that
  looks correct — because the difference between `'` and `’` is invisible at normal reading size.
- **`assertSendable` throws rather than returning a result.** A message that silently triples in cost is
  worse than one that fails in CI, and there is no sensible "carry on" branch. `maxSegments` defaults to
  1: the recovery SMS should fit in one, and needing two should be a deliberate decision.
- **`normaliseToGsm7` is deliberately narrow** — it fixes curly quotes, dashes, ellipses and
  non-breaking spaces, and nothing else. A general "strip anything unrepresentable" would turn
  `Café Cleaning` into `Caf Cleaning` in every message a business ever sends, and nobody would notice
  until a customer did. Emoji are likewise left to fail loudly rather than vanish. Both behaviours are
  tested as _requirements_, not accidents.
- **`é`, `ñ` and `ü` are in GSM-7** and pass unchanged, which matters for real AU business names.

**Connects to.** `CLAUDE.md` rule 5. `.claude/skills/twilio/SKILL.md` §6 (SMS copy rules). Every
outbound message template, and the send path.

**Verified 30/30, including a live demonstration of the cost bug.** The same sentence:

| Version                          | Encoding | Segments |
| -------------------------------- | -------- | -------- |
| `can't` / `we're` (straight `'`) | GSM-7    | **1**    |
| `can’t` / `we’re` (curly `’`)    | UCS-2    | **3**    |

One invisible character, 3× the bill on every send. Also confirmed: segment boundaries at 160/161 and
306/307; an empty body still bills one segment; an emoji forces UCS-2 and its surrogate pair counts as
two UTF-16 units; the error message names the offending code point; and `normaliseToGsm7` fixes curly
quotes without touching `é`.

**Watch out for.** This is a _pure_ module — nothing calls it yet. Rule 5 is now **enforceable**, not
enforced. It becomes real when message templates land and their tests call `assertSendable`; the
skill's requirement is that every outbound template is charset- and segment-asserted in CI.

Second: segment counting assumes Twilio's standard concatenation (UDH header, 153/67 per part). Twilio
may split differently for some carriers, so treat the count as the billing model, not a wire-format
guarantee.

Third — a small irony worth keeping. The first version of `normaliseToGsm7` contained a **literal
non-breaking space** in its own regex, and ESLint's `no-irregular-whitespace` rejected it. It is now
` `. An invisible character in the file whose job is catching invisible characters is exactly the
failure mode this module exists for.

#### `apps/api/src/common/phone.ts` · `phone.spec.ts`

**Step 13** · 2026-07-27

**What it does.** E.164 normalisation with an AU default, withheld-caller-ID detection, AU mobile
detection, and national-format display. 26 tests.

**Why it's written this way.**

- **Returns `null` rather than throwing.** An unparseable or withheld caller ID is an expected daily
  occurrence, not an exception. Throwing would mean a `try/catch` at every ingress point, and the one
  someone forgets is a crashed webhook.
- **`ANONYMOUS_MARKERS` includes `266696687`** — some carriers signal a withheld number with that reserved
  sequence rather than a text marker. Comparison strips non-alphanumerics and lowercases first.
- **Idempotence is tested explicitly.** Normalising an already-normalised number must be a no-op, because
  the value passes through this function more than once on its way to a unique constraint.
- **`toNationalDisplay` carries a warning in its doc comment** that it must never be used for `tel:`/`sms:`
  hrefs or storage — national format breaks when the handset is roaming.

#### `apps/api/src/main.ts` · `worker.ts` · `app.module.ts` · `health/health.controller.ts`

**Step 13** · 2026-07-27

**What it does.** The two entrypoints (D7), the shared root module, and liveness/readiness endpoints.

**Why it's written this way.**

- **`app.set('trust proxy', 1)` is in `main.ts` with a comment explaining why.** Twilio signature
  validation rebuilds the signed string from the request URL; behind a proxy `req.protocol` reports
  `http` while Twilio called `https`, and every signature fails with no useful error.
- **`forbidNonWhitelisted: true`,** so an injected `businessId` is a 400 rather than being silently
  stripped. Silent stripping protects the data but hides the attempt.
- **CORS uses an explicit origin, never `*`** — credentialed requests require it, and the dashboard sends
  the session cookie.
- **`worker.ts` uses `createApplicationContext`**, giving DI without an HTTP listener. A worker that opens
  a port gets health-checked and restarted by a platform that thinks it's a web service.
- **Liveness and readiness are separate endpoints.** If the database blips we want traffic to stop being
  routed here, not for the process to be killed and restarted — a restart does not fix someone else's
  database.

**Verified end to end:** `/health` → `{"status":"ok"}`, `/health/ready` → `{"status":"ok","database":"ok"}`
against the live container, and the worker boots through the same module graph.

#### `apps/web/*` — `next.config.ts`, `layout.tsx`, `globals.css`, `page.tsx`, `eslint.config.mjs`

**Step 13** · 2026-07-27

**What it does.** Next 16 / React 19 app-router skeleton. No product screens yet.

**Why it's written this way.**

- **`next.config.ts` loads the root `.env` explicitly**, because Next only reads `.env` from its own
  directory and the root file is the single source of truth.
- **There is no `eslint` key in `next.config.ts`.** Next 16 removed `next lint` and its build-time ESLint
  integration; linting is a separate step against `eslint.config.mjs`.
- **No `maximumScale` / `user-scalable=no` in the viewport.** Pinch-zoom is an accessibility need, and
  disabling it on a screen people read in sunlight is a bad trade.
- **44px minimum tap target in the reset**, because the primary actions are tapped by a thumb, outdoors,
  in a hurry.

**Watch out for — two upstream version conflicts resolved here.** `eslint-config-next` 16 ships **native
flat configs** as subpath exports; the `FlatCompat` bridge not only isn't needed, it _throws_ on this
config (circular reference during schema serialisation). And `eslint-plugin-react@7.37.5`, pulled in
transitively, is **incompatible with ESLint 10** (`contextOrFilename.getFilename is not a function`), so
the web app is pinned to **ESLint 9** while the API runs ESLint 10. Revisit when the plugin catches up.

---

### API

#### `apps/api/src/prisma/tenant-guard.ts`

**Step 14** · 2026-07-27

**What it does.** A Prisma client extension that throws `TenantScopeError` when a query against a
tenant-scoped model does not constrain by `businessId`. Implements D8.

**Why it's written this way.**

- **It asserts; it does not auto-inject.** The tempting design silently adds `where: { businessId }` to
  every query. Rejected because it _hides_ missing scoping rather than surfacing it — the first query
  shape the extension doesn't cover fails **open**, silently, in production. It also cannot work for
  Twilio webhooks or job processors, where the tenant comes from a phone-number lookup or `job.data`
  rather than a session; auto-injecting from an empty session would scope to nothing. Asserting behaves
  identically in all three contexts.
- **`TENANT_MODELS` lists models that don't exist yet.** A model is guarded from its first line rather
  than from whenever someone remembers to add it. Names absent from the schema are simply never queried,
  so listing them early costs nothing and closes the window where a new table is briefly unguarded.
- **`Business` and `User` are deliberately excluded.** `Business` _is_ the tenant, and both are
  legitimately read before a tenant is known — login and the magic-link exchange both happen without a
  `businessId` in hand.
- **`findUnique` is banned on tenant models — the least obvious decision here.** A unique lookup takes
  only unique fields, so `findUnique({ where: { id } })` cannot express a tenant constraint at all. The
  check then has to happen _after_ the query, in application code, which is exactly where it gets
  forgotten. `findFirst({ where: { id, businessId } })` pushes the constraint into the query and returns
  `null` for another tenant's row — which is the 404-not-403 behaviour the backend skill requires,
  achieved for free rather than by remembering to write it.
- **`businessId` must be top-level in `where`.** A shallow check is correct, not lazy: a `businessId`
  buried in an `OR` does not scope anything — `OR: [{ businessId }, { status: 'NEW' }]` matches every
  business's NEW rows. Requiring it at the top level makes that mistake impossible to express.
- **Unrecognised operations throw.** The default is fail-closed, so a Prisma upgrade that introduces a
  new operation breaks loudly here instead of quietly routing around the guard. The error names the two
  constants to edit.
- **`assertTenantScoped` is exported separately from the extension.** The check is pure — `(model,
operation, args) → void | throw` — so it is unit-testable without a database, a client, or a schema.
  That is what makes step 15's test suite cheap enough to be exhaustive.
- **Empty `createMany` arrays pass.** Writing zero rows leaks nothing, and throwing there would be noise.

**Connects to.** `docs/decisions.md` D8. `.claude/skills/backend/SKILL.md` §1 (the rule this enforces).
`prisma.service.ts` applies it (step 16). Every tenant model in `schema.prisma` is governed by it.

**Watch out for — three real gaps, none of them accidental.**

1. **Raw SQL bypasses this entirely.** `$queryRaw` / `$executeRaw` are not model operations, so the
   extension never sees them. Any raw query against a tenant table must carry its own
   `WHERE business_id = ...`, and there should be very few. The health check's `SELECT 1` is fine
   precisely because it touches no tenant table.
2. **The guard checks that a `businessId` is _present_, not that it is the _right_ one.** It cannot know
   which tenant the current request belongs to. Passing a `businessId` the user doesn't own still
   passes — which is why services take `businessId` explicitly from the session or the webhook's
   phone-number lookup, never from client input, and why `forbidNonWhitelisted` rejects an injected one
   at the DTO boundary. This is a net, not a wall.
3. **`prisma.unscoped` (step 16) is a deliberate hole.** Resolving a webhook's `To` number and looking
   up a magic-link token both happen before a tenant is known. Every call site must stay greppable and
   few — a growing list means the assertion is being worked around rather than satisfied.

#### `apps/api/src/prisma/tenant-guard.spec.ts`

**Step 15** · 2026-07-27

**What it does.** 71 tests over `assertTenantScoped`, covering non-tenant models, banned operations,
every where-scoped and data-scoped operation, the `OR` trap, upsert's two halves, unknown operations,
error diagnosability, and the model list itself. Total suite is now 97.

**Why it's written this way.**

- **No database, no Prisma client, no schema.** Step 14 exported the check as a pure
  `(model, operation, args) → void | throw` precisely so this suite could be exhaustive for near-zero
  cost. A test that needed a live Postgres per case would have been sampled instead of complete, and
  sampling a security boundary is how the uncovered case becomes the incident.
- **Real model names (`Lead`, `Business`) rather than fixtures.** Renaming a model should break these
  tests. A model that silently drops out of `TENANT_MODELS` during a rename is exactly the regression
  worth catching, and a fixture name would hide it.
- **The `OR` trap gets its own describe block.** It is the reason the check is shallow rather than
  recursive, so it is tested as behaviour rather than left as a comment. The `AND` case is tested too,
  and documents that we reject a query that _would_ actually be safe — the trade is that the rule stays
  one sentence long instead of requiring the guard to walk boolean trees and decide which branches are
  load-bearing.
- **Upsert is tested as two independent halves.** Scoping the `where` but not the `create` is the
  dangerous asymmetry: the insert branch is the one that writes a row into the wrong tenant, and it is
  easy to scope the lookup and forget the insert.
- **Error _messages_ are asserted, not just error types.** `findUnique` must name `findFirst` in its
  message, and an unknown operation must name `WHERE_SCOPED`. When this guard fires, it fires on someone
  who does not yet know the rule — the message is the documentation they will actually read.
- **The last block tests `TENANT_MODELS` itself.** It guards the guard: it fails if someone prunes the
  list back to "only the models that exist today", which would silently unprotect every table added
  after that.

**Connects to.** `tenant-guard.ts` (the only thing under test). Runs under `apps/api/jest.config.js`.

**Watch out for.** These tests prove the guard _rejects unscoped queries_. They cannot prove the
application passes the _correct_ `businessId` — that needs integration tests authenticating as business
A and requesting business B's records (`.claude/skills/backend/SKILL.md` §8). Green here is necessary,
not sufficient.

Also: `expect.assertions(5)` in the diagnosability test is doing real work — it proves the `catch` block
ran at all. Without it, a version of `assertTenantScoped` that never threw would pass that test silently.

---

### API — notifications

#### `apps/api/src/notifications/templates.ts`

**Step 41** · 2026-08-02

**What it does.** The four caller-facing SMS templates, and a **module-load assertion** that every one
of them is GSM-7 and one segment at the worst legitimate business name.

The actual copy:

```
Melbourne Sparkle Cleaning: sorry we missed your call. What do you need help
with, and which suburb are you in? Reply STOP to opt out.          [134 chars, 1 seg]
```

**Why it's written this way.**

- **The assertion runs at import, not in a test.** A template that costs three times as much, or that
  drops the opt-out notice, must not be _deployable_ — so the guard runs in CI, in dev, and at boot in
  production. A test can be skipped or forgotten; an import cannot. The failure this guards is silent
  and recurring, which is the shape that earns a boot-time check rather than a warning.
- **Templates are functions, not format strings.** The business name has to be interpolated before the
  segment count means anything: a 158-character template plus a 30-character name is two segments, and
  asserting the template alone would miss it. Everything is checked as the complete message.
- **Assertions use a worst-case name** (`MAX_BUSINESS_NAME` = 32), not a convenient short example that
  hides the boundary. The first message leaves 20 characters of headroom at that size.
- **Over-long names are truncated, not allowed through.** Truncation is visible and cheap; silently
  doubling the cost of every message a business sends is neither. A 200-character name still yields one
  segment.
- **The business name is the first thing in the message**, satisfying Spam Act sender identification and
  doing double duty as the caller's only signal that a text from an unknown number is legitimate — the
  voice greeting told them to expect it seconds earlier.
- **The first message asks one open question, not a list.** Six sequential questions lose most people by
  the third, and every abandoned conversation still costs money. Verified: exactly one `?`.
- **There is deliberately no `{price}` placeholder.** Rule 2 says every currency figure comes from
  `PriceCalculator` at send time. Making the template incapable of holding one removes the temptation.
- **A separate known-contact variant exists.** "What do you need help with?" to someone ringing about a
  job already booked reads as automated and erodes trust; that message says a human will call back and
  gets out of the way.
- **The handoff message promises nothing** — no time, no price, no availability. We know none of them,
  and promising any on the business's behalf is a representation we cannot stand behind.

**Connects to.** `common/gsm7.ts` (the assertion). `CLAUDE.md` rules 2, 5, 10. `docs/compliance.md` §1.
Will be used by the recovery job processor.

**Verified 18/18.** All four templates are one GSM-7 segment at worst case. Sender identification is at
character 0. The opt-out notice is present on both first-contact messages and correctly absent from the
handoff. No template contains marketing language (`off|discount|deal|offer|save|free|special|promo|book
now`) or any currency pattern. A curly apostrophe in a _business name_ is normalised so it cannot triple
the cost, while `é` survives. And the guard was shown to have teeth: a deliberately curly-quoted
template is rejected.

**Watch out for.** `MAX_BUSINESS_NAME` is 32 characters, which truncates real names — "Melbourne End of
Lease Cleaning Specialists" becomes "Melbourne End of Lease Cleaning." That is the right trade against a
second segment on every message, but it is a _product_ decision, and an owner should see their truncated
name during onboarding rather than discovering it in a customer's inbox.

Second: these templates are fixed strings. The plan allows owners to configure their own questions, and
the moment a template becomes owner-editable this import-time guard no longer covers it — owner-supplied
copy has to be asserted on save _and_ at send, because a boot-time check cannot see data.

#### `apps/api/src/telephony/sms.provider.ts`

**Step 42** · 2026-08-02

**What it does.** Defines the `SmsProvider` interface (send + Lookup), the `PermanentSendError` type and
the no-retry error-code set, and ships `FakeSmsProvider` — an in-memory implementation that records
every send.

**Why it's written this way.**

- **The seam exists before the first real send, deliberately.** The `twilio` skill §8 says to build it
  from commit one, and the reason is concrete: without it, every integration test costs money and needs
  a physical handset, and by the time the SDK is called from six places the seam is expensive to
  retrofit. Writing it now costs one file; writing it later costs a refactor of the send path.
- **The fake enforces the same GSM-7 rule as the real provider.** This is the most important line in the
  file. A fake that happily accepts `We’re on our way` would let a UCS-2 template pass every test and
  then cost 3× in production — the failure would be _invisible in CI and expensive in production_, which
  is the worst possible split. Verified: the fake rejects it and does not record the send.
- **Permanent and transient failures are different types, not a flag.** Retrying a permanent failure
  burns four more API calls to be rejected identically and buries the cause under a stack of timeouts
  (`queues-redis` §4). `PermanentSendError` carries the Twilio code so the processor can act on it —
  21610 in particular must write a suppression row rather than retry.
- **21610 is called out in the code comment, not just listed.** Twilio maintains its own opt-out list per
  sending number and rejects sends even when our database believes a number is fine. It is the
  authoritative signal that the two lists have diverged, and treating it as a generic failure would mean
  retrying a send that is legally required to stop.
- **The interface is narrow — send and lookup, nothing else.** Small enough that the fake is obviously
  correct, and short enough that replacing Twilio would be a contained job.
- **`failNextSendWith` is one-shot.** A sticky failure mode makes a test that forgets to reset poison
  every later assertion in the file, usually far from the cause.
- **`setLineType` lets a test simulate a landline** without a real Lookup call, which costs ~US$0.008
  each and would otherwise make the "do not text landlines" path untestable.

**Connects to.** `common/gsm7.ts` (the shared assertion). `notifications/templates.ts` (what gets sent).
`.claude/skills/twilio/SKILL.md` §4, §5, §8. The real Twilio adapter and the recovery processor both bind
to `SMS_PROVIDER`.

**Verified 16/16.** Sends are recorded with a Twilio-shaped `MessageSid` and a `queued` status; the fake
rejects a curly-quote body _and does not record it_; a `PermanentSendError` is distinguishable from a
plain `Error` and carries its code; the queued failure is one-shot; the no-retry set covers unsubscribed,
invalid `To`, landline, bad `From` and geo-permissions; a landline can be simulated; and `reset` clears
state between tests.

**Watch out for.** `FakeSmsProvider` is exported from the same file as the interface, so it ships in the
production bundle. That is deliberate — it keeps the contract and its reference implementation in one
place, and it is a few hundred bytes — but nothing stops it being bound in production by mistake. The
module that provides `SMS_PROVIDER` must make the choice explicit and log which implementation is active
at boot.

Second: the interface has no `getMessageStatus`. Delivery status arrives by webhook rather than polling,
which is correct — but it means a message whose status callback is never delivered stays `queued`
forever, with nothing to reconcile it. That reconciliation job is worth existing before a pilot.

---

### API — businesses

#### `apps/api/src/businesses/business-name.ts`

**Step 43** · 2026-08-02

**What it does.** Validates a business name for SMS use and returns an owner-facing error naming the
exact offending character. Also provides `businessNameForSms`, a last-resort strip used at the send
boundary, and `previewRecoveryMessage` for onboarding.

**Why it exists — a flaw found by review, not by a test.**

Step 41 documented that `normaliseToGsm7` deliberately does not delete characters, on the principle that
silently mangling a business name is worse than failing loudly. The principle is right. **It was applied
in the wrong place.** Traced end to end:

```
prepareBusinessName('Sparkle Cleaning 🧼')  →  "Sparkle Cleaning 🧼"   emoji survives
recoveryFirstMessage(...)                  →  UCS-2, 2 segments
sendSms(...)                               →  THREW Gsm7ViolationError
                                              messages sent: 0
```

The module-load guard does not catch it — `assertAllTemplates()` checks a worst-case _ASCII_ name, not
runtime data. So the failure lands at the worst possible moment: a real customer rings, we answer and
promise a text, and the send throws. **The lead is lost, for every call to that business, until someone
reads the logs.**

| Behaviour                                 | Cost | Lead     |
| ----------------------------------------- | ---- | -------- |
| Throw at send (what step 41 did)          | $0   | **lost** |
| Send as UCS-2                             | 2×   | kept     |
| Reject at input + strip as fallback (now) | 1×   | kept     |

**Why it is written this way.**

- **Rejection happens at input, where nobody is harmed.** The owner sees
  `🧼 (emoji) cannot be sent in a text message. Please remove it — your name would need to be "Sparkle
Cleaning".` They fix it before a single customer is affected. Validation belongs early and loud; the
  send path should degrade, not fail.
- **The message names the character and shows the result.** "Special characters are not allowed" sends
  a cleaner hunting through a box that looks fine. Showing `🧼` and the corrected name makes the fix
  obvious. `offenders` is returned so the UI can highlight it.
- **Accented Latin is accepted, not rejected.** `é ñ ü à` are all in GSM-7, so `Café Cleaning` sends
  perfectly and must not be refused. An owner told "special characters aren't allowed" while `Café`
  works would rightly stop trusting the message. Over-rejecting is its own bug.
- **Curly quotes are fixed, not refused.** Someone pasting `Dave’s Cleaning` from a document should not
  be told their apostrophe is illegal — it is unambiguous and repairable.
- **`stripToGsm7` is named for what it does and is separate from `normaliseToGsm7`.** One deletes, one
  substitutes. Keeping them apart means the deleting one cannot be reached by accident, and it tidies
  the double space that deleting a mid-string character leaves behind.
- **`businessNameForSms` returns what it stripped**, so the caller can log a warning. Degrading silently
  is how a mangled name goes unnoticed for months.

**Connects to.** `common/gsm7.ts`, `notifications/templates.ts`, `telephony/sms.provider.ts`. The
`businesses` module DTO will call `validateBusinessName` on create and update; the dashboard shows
`message` verbatim.

**Verified 21/21.** The emoji name is rejected with an actionable message; CJK likewise; blank and
over-long have their own messages; `Café Cleaning`, `Ñoño & Sons`, `Dave's Cleaning` and
`A-1 Cleaning (Melb)` are all accepted; a curly apostrophe is straightened rather than refused; 32
characters is accepted and 33 is not; `stripToGsm7` leaves no double or trailing space. Most
importantly: **the send that previously threw now succeeds, at one segment.**

**Watch out for.** Nothing enforces this yet — the `businesses` module does not exist, so no write path
calls `validateBusinessName`. The fallback in `businessNameForSms` is also not wired into the templates,
which still call `prepareBusinessName`. **Until both are connected, an emoji name still loses leads.**
The mechanism is built and correct; two call sites remain.

Second: `MAX_BUSINESS_NAME` (32) is enforced here as a _rejection_, while `prepareBusinessName` silently
truncates. Two different behaviours for the same limit. Rejection is right at input, truncation is right
at send — but they must not drift, and the constant lives in `templates.ts` rather than somewhere both
clearly own.

#### `apps/api/src/notifications/templates.ts` — degrading fallback wired

**Step 44** · 2026-08-02

**What it does.** `prepareBusinessName` now strips unsendable characters instead of letting them reach
the send path, and a new `prepareBusinessNameVerbose` reports what it removed. **This closes the
lead-losing path identified in step 43** — the half that step 43 built but did not connect.

**Why it is written this way.**

- **The strip happens in the templates, not at the call site.** Every template interpolates the name, so
  putting the guard anywhere else means each future template has to remember it. Here it cannot be
  forgotten.
- **`prepareBusinessNameVerbose` exists so degradation is reportable.** A business sending under a name
  that is not quite theirs is recoverable, but the owner has to be _told_ — silently degrading is how a
  mangled name goes unnoticed for months. `stripped` and `truncated` are separate flags because they are
  different problems with different fixes.
- **`businessNameForSms` was rewritten as a thin alias** rather than left as a parallel copy. Step 43
  introduced a second "make this name sendable" implementation; two would eventually disagree, and the
  one the send path actually uses is the one that must be right. There is now exactly one, and a test
  asserts the two entry points agree.
- **The dependency runs `businesses/business-name.ts` → `notifications/templates.ts`, never back.**
  Templates must not depend on the businesses domain — and the reverse direction would make this file's
  module-load assertion transitively import a validator that imports these templates, which is a cycle
  that only shows up at runtime.
- **Input validation still rejects.** Degradation is a fallback for data that predates the check, not a
  licence to accept anything. `validateBusinessName` is unchanged and still refuses an emoji name with an
  actionable message.

**Verified 15/15.** The exact case from step 43 now sends:

```
"Sparkle Cleaning: sorry we missed your call. What do you need help with,
 and which suburb are you in? Reply STOP to opt out."      GSM-7, 1 segment
```

Previously `Gsm7ViolationError`, 0 messages sent. All four templates are GSM-7 and one segment with an
emoji business name; `é` is preserved and a curly quote straightened; a clean name reports nothing
stripped; truncation is reported separately from stripping; and `businessNameForSms` and
`prepareBusinessNameVerbose` return identical results.

**Watch out for.** One call site remains unwired: nothing calls `prepareBusinessNameVerbose` yet, so the
`stripped` warning is available but never logged. The recovery processor should log it when it sends —
otherwise a business quietly messaging under a shortened name is invisible until someone asks.

Second: `validateBusinessName` is still not called by any write path, because the `businesses` module
does not exist. Input rejection — the part that actually prevents the problem — is built and unreachable.
The send path is now safe regardless, which is the point of defence in depth, but the owner-facing error
message has nowhere to appear yet.

#### `apps/api/src/telephony/twilio-sms.provider.ts`

**Step 45** · 2026-08-02

**What it does.** The real `SmsProvider`: sends via the Twilio SDK, performs Lookup v2, and classifies
SDK errors as permanent or retryable.

**Why it is written this way.**

- **GSM-7 is asserted before the network call.** Failing locally costs nothing; a UCS-2 message that
  reaches Twilio is billed at three times the price and cannot be un-sent. The check is deliberately
  duplicated between here and the fake so both providers behave identically — a fake that is more
  permissive than the real one is worse than no fake.
- **Error classification is the whole point of this file.** BullMQ's retry decision hangs on it:
  retrying a permanent failure burns four more API calls to be rejected identically and buries the cause
  under timeouts, while _not_ retrying a transient one loses a lead to a network blip. Permanent means
  "will fail identically forever" — unsubscribed, invalid `To`, landline, bad `From`, geo-permissions.
  A rate limit (20429) is explicitly **not** permanent.
- **21408 logs at `error` with the fix in the message.** Geo-permissions is a configuration fault, not a
  bad recipient: it fails for _every_ send and looks exactly like a code bug. Naming the console setting
  in the log line is the difference between a five-minute fix and a day of debugging the wrong layer.
- **API key + secret preferred over the auth token.** A leaked key can be revoked individually; the auth
  token cannot, because signature validation depends on it. The boot log says which is in use, so
  running on the weaker credential is visible rather than assumed.
- **The constructor throws without `TWILIO_ACCOUNT_SID`.** `env.ts` makes Twilio credentials optional so
  the app can boot before the AU regulatory bundle clears — that convenience must not silently produce a
  provider that fails on first send. The error names the fix: bind `FakeSmsProvider` instead.
- **A failed Lookup returns `unknown` rather than throwing.** The send path treats `unknown` as
  "proceed", so a bad day at Lookup degrades to sending normally. Throwing would mean refusing to text
  anyone whenever an auxiliary API is unavailable — a much worse failure than an occasional wasted send.
- **Our own segment count wins over Twilio's `numSegments`.** Twilio reports it as a string and only
  sometimes; ours is computed identically for every message whether sent or not, which is what makes
  cost reporting comparable.

**Connects to.** `sms.provider.ts` (the interface and error taxonomy), `common/gsm7.ts`,
`config/env.ts`, `docs/twilio-setup.md` §2 and §6.

**Verified 13/13, with no network calls and nothing billed.** All five permanent codes classify as
`PermanentSendError` carrying their code; rate limit, queue overflow and 500 classify as retryable; a
non-Twilio error passes through unchanged and a non-`Error` value is wrapped rather than rethrown raw; a
UCS-2 body is rejected locally before Twilio is contacted; and the constructor refuses to build without
credentials.

**Watch out for — a bug the compiler caught, worth remembering.** The first version read
`(raw && LINE_TYPE_MAP[raw]) ?? 'unknown'`. An empty string is **falsy but not nullish**, so `raw && …`
short-circuits to `''` and `??` does not replace it — producing `''` as a line type, which is not a
valid value and would have flowed into `Customer.lineType`. `noUncheckedIndexedAccess` surfaced it. The
fix indexes with a fallback key instead: `LINE_TYPE_MAP[raw ?? ''] ?? 'unknown'`. The `&&`/`??` mix is
an easy trap wherever empty strings are plausible.

Second: **nothing binds this provider yet.** No module provides `SMS_PROVIDER`, so neither the real nor
the fake implementation is injectable. The binding — and the decision of which to use per environment —
is the next step, and it must log which one is active, because a production deployment silently running
the fake would report every send as successful while sending nothing.

#### `apps/api/src/telephony/sms-provider.factory.ts`

**Step 46** · 2026-08-02

**What it does.** Decides whether `SMS_PROVIDER` resolves to the real Twilio adapter or the in-memory
fake, and makes that decision loud.

**The failure it is designed against.** A production deployment silently running the fake. Every send
would be recorded as successful, every metric would look healthy, and **no customer would receive
anything**. Nobody notices until a business asks why their leads stopped — by which point those callers
are long gone. It is the worst class of bug this system can have: total functional failure that reports
success.

**Why it is written this way.**

- **Production does not warn — it refuses to start.** A misconfiguration that silently sends nothing is
  strictly worse than one that fails to boot, because the second is noticed in the first minute. The
  error names the missing variables and explains that the fake does not deliver.
- **Half-configured counts as not configured.** An account SID without `TWILIO_SMS_NUMBER` would
  authenticate happily and then fail at the first message — putting the error in the wrong place, hours
  later, inside a job retry. Both are required at boot.
- **Selection is by credentials, never by a flag.** A `USE_FAKE_SMS=true` left set in a deployment is
  exactly how the silent failure happens. There is no such flag; the presence of real credentials _is_
  the switch.
- **The boot log states the consequence, not the class name.** `Using TwilioSmsProvider — messages will
be DELIVERED from +61488887777` and, in development, `messages are recorded in memory and NOT
delivered`. Someone testing the recovery flow locally and wondering why no text arrived has the answer
  in the startup output.
- **`createSmsProvider` is exported separately from the Nest provider** so the decision can be tested
  without a DI container — which is how all five environment combinations were checked cheaply.

**Connects to.** `sms.provider.ts` (`SMS_PROVIDER` token, `FakeSmsProvider`),
`twilio-sms.provider.ts`, `config/env.ts`, `docs/twilio-setup.md`.

**Verified 12/12** across every environment combination:

| `NODE_ENV`  | Twilio config       | Result                                      |
| ----------- | ------------------- | ------------------------------------------- |
| production  | none                | **throws — refuses to start**               |
| production  | SID only, no number | **throws**                                  |
| production  | complete            | real provider, boots                        |
| development | none                | fake, warns "NOT delivered"                 |
| development | complete            | real provider, log names the sending number |

**Watch out for.** Nothing registers this factory yet — `TelephonyModule` does not include it, so
`SMS_PROVIDER` is still not injectable anywhere. That is the next step.

Second: the production guard checks `NODE_ENV`, which is set by the deployment. A staging environment
running `NODE_ENV=development` with no Twilio credentials would quietly use the fake — correct
behaviour, but it means "did anything actually send?" must be answered from the boot log rather than
assumed. The log line exists for exactly that question.

#### `apps/api/src/telephony/telephony.module.ts` — `SMS_PROVIDER` registered

**Step 47** · 2026-08-02

**What it does.** Adds `smsProviderFactory` to the providers and exports `SMS_PROVIDER`, making the SMS
provider injectable and putting the delivery-mode line into every boot.

**Why it is written this way.**

- **`SMS_PROVIDER` is exported, unlike the signature guard.** The recovery job lives in the worker, not
  in telephony, and it is what actually sends. Telephony owns the Twilio boundary; other modules consume
  the interface and never import the SDK. That is what keeps `twilio` out of the dependency graph of
  everything above this layer.
- **The factory runs at module construction, so the log happens exactly once.** A `useClass` binding
  would give no place to log the decision, and logging per injection would bury it.

**Connects to.** `sms-provider.factory.ts`, `sms.provider.ts`, `twilio-sms.provider.ts`. The recovery
processor will inject `SMS_PROVIDER` from here.

**Verified 6/6 through DI, plus a real boot.** The provider resolves from `TelephonyModule`'s own scope,
is a single shared instance (two would mean a test asserting on `sent` silently misses real sends),
sends successfully through the injected instance, and is reachable from a downstream consumer module —
which is exactly what the worker will be.

The application boot log now carries the line the factory exists for:

```
WARN [SmsProvider] Using FakeSmsProvider — messages are recorded in memory and NOT
delivered. Set TWILIO_ACCOUNT_SID and TWILIO_SMS_NUMBER to send for real.
```

`/health/ready` still returns `{"status":"ok","database":"ok"}` and all four routes still map.

**Watch out for.** This repo currently has no `TWILIO_ACCOUNT_SID`, so **every environment resolves to
the fake** — including anything deployed from here. That is correct and loudly announced, but it means
the send path cannot be tested against a real handset until the AU regulatory bundle clears and the
number is bought (`docs/twilio-setup.md` §3–4). The warning in the boot log is the only thing standing
between "the pilot works" and "the pilot sent nothing".

Second: `SMS_PROVIDER` is now injectable but **nothing injects it**. No message is sent anywhere in the
system yet. The `messages` table and the recovery processor are what close that.
