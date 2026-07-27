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

| Heading | Answers |
|---|---|
| **What it does** | Its one responsibility, in plain language |
| **Why it's written this way** | The reasoning, and what was rejected |
| **Connects to** | What it depends on and what depends on it |
| **Watch out for** | The thing that will bite someone later |

### Boundary with `docs/decisions.md`

This file explains **files**. `docs/decisions.md` records **choices that span files** — no voicemail,
four pricing types, SMS-first owner surface. When a file embodies a decision, its entry links to the
decision rather than restating the argument.

---

## Build log

| # | Date | File | In one line |
|---|---|---|---|
| 1 | 2026-07-27 | `CLAUDE.md` | Project brief, build protocol, and the 12 engineering invariants |
| 2 | 2026-07-27 | `docs/codebase.md` | This file — the running per-file explanation |
| 3 | 2026-07-27 | `.claude/skills/twilio/SKILL.md` | Telephony reference: webhooks, Lookup, opt-out, SMS segments, testing |
| — | 2026-07-27 | `CLAUDE.md` | Amended rule 7 — signatures validate over URL + sorted params, not raw body |
| 4 | 2026-07-27 | `.claude/skills/queues-redis/SKILL.md` | BullMQ and Redis: persistence, idempotency, retries, delayed work |
| 5 | 2026-07-27 | `.claude/skills/backend/SKILL.md` | NestJS + Prisma: tenancy assertion, modules, auth, migrations, money |
| 6 | 2026-07-27 | `.claude/skills/frontend/SKILL.md` | Next.js dashboard: cookie domain, magic link, mobile-first, en-AU formatting |
| 7 | 2026-07-27 | `docs/decisions.md` | ADR-lite: 12 locked decisions with rejected alternatives, 5 pending |
| 8 | 2026-07-27 | `docs/carrier-forwarding-test.md` | The go/no-go gate — protocol and empty results matrix |
| 9 | 2026-07-27 | `docs/twilio-setup.md` | Account runbook: bundle, geo permissions, numbers, webhooks, usage triggers |
| 10 | 2026-07-27 | `docs/compliance.md` | Spam Act position, sender split, privacy posture, price representations, retention |
| 11 | 2026-07-27 | `.claude/settings.json` | Permission allowlist, and denies for the destructive Prisma commands |

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
  *"my last cleaner charged $200, can you beat it?"* is an invitation to negotiate, and a helpful model
  will take it. The rule closes that, and `docs/` carries a matching test.
- **The Commands section is deliberately empty.** Writing `pnpm dev` before a workspace exists produces
  a file that lies, and a lying `CLAUDE.md` is worse than a thin one. It gets filled in as scaffolding
  lands.
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
- **Four fixed headings.** Uniform entries make the document skimmable and make the *absence* of
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
  the plan (see *Watch out for*). Behind a proxy the reconstructed URL is `http` while Twilio called
  `https`, so every signature fails with no useful error. It is by far the most common cause of this bug
  and deserved the top of the section.
- **Error codes are a table, with 21408 first and a note on 30007.** 21408 (geo permissions) looks
  exactly like a code bug on a fresh account and can burn a day. 30007 (carrier filtering) is silent
  from the sender's side and is an *operational* argument for keeping messages transactional — worth
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
voice and messaging webhooks are form-encoded, and Twilio signs *URL + alphabetically sorted params* —
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
  `maxmemory-policy noeviction` — cause failures that produce *no error at all*. A non-persistent Redis
  drops every delayed job on restart; `allkeys-lru` evicts job data under memory pressure. Both look
  like "the follow-ups just didn't send." Everything else in the file is recoverable by reading a stack
  trace; these two aren't, so they go first.
- **"`jobId` is not enough" is its own section.** The natural assumption is that BullMQ's `jobId`
  provides idempotency. It only deduplicates while the job is *in* the queue — once completed and
  removed, the same id runs again. Durable idempotency has to live in Postgres. Left implicit, this
  produces duplicate SMS to real customers.
- **The retry table lists what must *not* retry.** Twilio 21610 and 21614 fail identically every time;
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

Also: the stalled-job mechanism re-runs a job *while the first run is still in progress* if a processor
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
  `where: { businessId }` everywhere. Rejected for two reasons. It *hides* missing scoping rather than
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
- **"Never mock Prisma."** Mocked query builders assert the *shape* of a call rather than that the query
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
  `app.yourdomain.com` → `api.yourdomain.com` is cross-origin but *same-site*, so `SameSite=Lax` cookies
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
- **The decision tree is written *before* the results exist.** Deciding what "only two carriers work"
  means while staring at a disappointing result invites rationalisation. Three named outcomes with
  pre-committed responses — including "stop and redesign" with three ranked alternatives — removes that.
- **Nine rows, not three.** Conditional forwarding is three separate GSM settings. Testing only
  no-reply would miss that declining a call fires busy (`**67*`), and declined calls are a large share of
  real misses — a tradie glancing at a ringing phone with wet hands.
- **Includes the billing check.** The *business* is charged for the forwarding leg. It's usually $0 on
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
- **Usage triggers are documented as a *backstop*, not the primary control.** Application-level caps
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
- **It states an argument, not a conclusion.** §1 sets out *why* we think the recovery flow isn't a
  commercial electronic message — the caller initiated contact seconds earlier — and then shows that the
  argument only holds while messages stay transactional. That's what makes `CLAUDE.md` rule 10 absolute
  rather than a style preference: one promotional sentence retroactively changes our consent position.
- **Legal and operational reasons are connected where they coincide.** Twilio error 30007 (silent
  carrier filtering) correlates with promotional-looking content. Two independent reasons pointing the
  same way make the rule much harder to erode.
- **The privacy section states current status accurately rather than conveniently.** The small business
  exemption has *not* been removed. Saying so, then arguing to build to APP standard anyway, is more
  durable than overstating the obligation — an overstatement gets discovered and then the whole document
  loses authority.
- **Price representations get their own section.** It's the highest-exposure thing the product does, and
  it's new since the original plan. The GST single-price rule is the trap: owners enter ex-GST prices
  without thinking, and the caller-facing figure must be inclusive regardless.
- **Retention makes opt-outs an explicit exception to data minimisation.** Deleting an opt-out record
  re-enables messaging someone who said stop. Keeping it *is* honouring the request, and that inversion
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





