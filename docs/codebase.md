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

| #   | Date       | File                                   | In one line                                                                        |
| --- | ---------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | 2026-07-27 | `CLAUDE.md`                            | Project brief, build protocol, and the 12 engineering invariants                   |
| 2   | 2026-07-27 | `docs/codebase.md`                     | This file — the running per-file explanation                                       |
| 3   | 2026-07-27 | `.claude/skills/twilio/SKILL.md`       | Telephony reference: webhooks, Lookup, opt-out, SMS segments, testing              |
| —   | 2026-07-27 | `CLAUDE.md`                            | Amended rule 7 — signatures validate over URL + sorted params, not raw body        |
| 4   | 2026-07-27 | `.claude/skills/queues-redis/SKILL.md` | BullMQ and Redis: persistence, idempotency, retries, delayed work                  |
| 5   | 2026-07-27 | `.claude/skills/backend/SKILL.md`      | NestJS + Prisma: tenancy assertion, modules, auth, migrations, money               |
| 6   | 2026-07-27 | `.claude/skills/frontend/SKILL.md`     | Next.js dashboard: cookie domain, magic link, mobile-first, en-AU formatting       |
| 7   | 2026-07-27 | `docs/decisions.md`                    | ADR-lite: 12 locked decisions with rejected alternatives, 5 pending                |
| 8   | 2026-07-27 | `docs/carrier-forwarding-test.md`      | The go/no-go gate — protocol and empty results matrix                              |
| 9   | 2026-07-27 | `docs/twilio-setup.md`                 | Account runbook: bundle, geo permissions, numbers, webhooks, usage triggers        |
| 10  | 2026-07-27 | `docs/compliance.md`                   | Spam Act position, sender split, privacy posture, price representations, retention |
| 11  | 2026-07-27 | `.claude/settings.json`                | Permission allowlist, and denies for the destructive Prisma commands               |
| 12  | 2026-07-27 | `pnpm-workspace.yaml`                  | Monorepo shape, and the pnpm build-script allowlist Prisma needs                   |
| 13  | 2026-07-27 | Scaffolding batch                      | Root config, both apps, Prisma + first migration, health, phone helper — see below |

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
