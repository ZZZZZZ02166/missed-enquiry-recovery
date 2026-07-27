# Missed-Enquiry Recovery Platform

When an Australian local service business misses a phone call, we text the caller back within
60 seconds, collect the job details, quote where the owner has configured a price, and hand the owner a
structured lead. First niche: end-of-lease cleaning and property maintenance in Melbourne.

---

## ⚠️ Build protocol — read this before writing anything

**One file per step.**

1. State which single file is next and why.
2. Write or modify **exactly one file**.
3. Append that file's entry to `docs/codebase.md` — what it does, **why it's built this way**.
4. Stop. Summarise: what it does, what it depends on, what's next.
5. Wait. Nothing further until the user says **continue**.

No batching. No "while I was in there." If a file cannot work without a sibling, say so and let the user
choose the order — do not create it unprompted.

**Not counted as steps:** the `docs/codebase.md` entry (it is part of the step, not a step of its own),
and generated artifacts — Prisma migrations, Prisma client, lockfiles — plus the commands that produce
them. Still name any generated artifact before running the command.

The user may override per message (_"do steps 2–4"_, _"continue ×3"_). The default is always one.

---

## Locked decisions

Full reasoning in `docs/decisions.md`. Do not relitigate these without being asked.

| Area                     | Decision                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Caller experience**    | Twilio answers the forwarded call, plays one TTS line announcing the incoming text, hangs up. **No voicemail, no call recording.**                                                                                                      |
| **Phone connection**     | Conditional call forwarding from the business's existing number (all three GSM conditions: no-reply, busy, unreachable). They never change their advertised number.                                                                     |
| **Pricing**              | Owner-configured service catalogue, four pricing types: `FIXED`, `STARTING_FROM`, `PER_UNIT`, `MANUAL_QUOTE`. The advanced beds × baths × carpet × suburb matrix is a post-pilot fast-follow, but the schema must accept it additively. |
| **Owner surface**        | Structured lead **SMS + magic link** is primary. The dashboard is the review surface, not the main one.                                                                                                                                 |
| **A call is not a lead** | `leads` are created lazily, on the customer's **first reply**. Calls that never get a response stay as `calls`.                                                                                                                         |

---

## Stack

Next.js (dashboard) · NestJS on Express (API + worker) · PostgreSQL + Prisma · BullMQ + Redis ·
Twilio (voice, SMS, Lookup) · S3/R2 (photos) · Stripe (later) · Sentry.

**One NestJS codebase, two entrypoints** — `main.ts` (HTTP) and `worker.ts` (BullMQ processors). Same
modules, same image, different start command. Never a separate worker package.

---

## Hard rules — these are invariants, not preferences

1. **Tenancy.** Every query is scoped by `businessId` taken from the authenticated session. Never from a
   request body, query param, or anything the client controls. No unscoped `findMany`.
2. **The model never prices.** The LLM returns `{ serviceId, fieldValues }` only. Every currency figure
   in an outbound message comes from `PriceCalculator` computing over the owner's stored config. No
   inventing, guessing, discounting, negotiating, or overriding — including when the caller asks.
3. **No call recording, ever.** Store metadata only: from, to, start, end, outcome, provider SIDs.
4. **No MMS.** US$0.35 each way and unreliable in AU. Photos go through a tokenised web upload link.
5. **Outbound SMS is GSM-7 only.** One curly apostrophe or emoji drops the segment limit from 160 to 70
   characters and can triple the bill. Templates are charset- and segment-asserted in CI.
6. **Phone numbers are E.164, normalised at the edge**, before any lookup, dedup, or storage.
7. **Twilio signatures validate over URL + alphabetically sorted params**, not the raw body — and the
   **URL** is what breaks: behind a proxy `req.protocol` is `http` while Twilio called `https`, so every
   signature fails silently. Pin the public base URL in env. Set `rawBody: true` anyway, for JSON
   `bodySHA256` payloads and for Stripe later.
8. **Webhooks: validate → persist → enqueue → return.** Twilio times out around 15s. Never send an SMS
   or call an LLM inside the request.
9. **Every external event is idempotent** via `webhook_events` unique `(provider, externalEventId)`.
   Replaying the same payload three times must produce exactly one call, one SMS, one lead.
10. **No marketing in the recovery flow.** No offers, no discounts, no promotions — ever. This is what
    keeps the messages arguably outside "commercial electronic message" territory under the Spam Act.
11. **Money is integer cents, AUD**, and anything shown to a caller is **GST-inclusive** regardless of
    how the owner entered it (ACL single-price rule).
12. **Time comes from `businesses.timezone`** (`Australia/Melbourne`), never server local time. DST will
    otherwise break scheduling twice a year.

---

## Repo layout

```
missed-enquiry-recovery/
├── CLAUDE.md
├── docs/                  # see below
├── .claude/skills/        # loaded on demand: twilio, queues-redis, backend, frontend
├── apps/
│   ├── api/               # NestJS — main.ts (HTTP) + worker.ts (BullMQ)
│   └── web/               # Next.js dashboard
├── packages/shared-types/
└── docker-compose.yml     # Postgres + Redis (persistent)
```

**API modules (10):** `auth`, `businesses`, `services`, `telephony`, `calls`, `conversations`, `leads`,
`notifications`, `jobs`, `common` (+ `prisma`).

**Tables (12):** `businesses`, `users`, `phone_numbers`, `services`, `customers`, `calls`,
`conversations`, `messages`, `leads`, `attachments`, `suppressions`, `webhook_events`.

---

## Documentation

| File                              | Contents                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/codebase.md`                | **Every file gets an entry** — what it does and why it's built that way. Written at the same time as the file so it can't drift. Build log at the top. |
| `docs/decisions.md`               | Choices that span files, with dates and reasoning. `codebase.md` links here rather than restating.                                                     |
| `docs/twilio-setup.md`            | Account, AU regulatory bundle, numbers, webhook URLs, error codes.                                                                                     |
| `docs/carrier-forwarding-test.md` | Telstra/Optus/Vodafone results matrix. **Go/no-go gate — fill in before product code.**                                                                |
| `docs/compliance.md`              | Spam Act, opt-out, GST/single-price, privacy, retention.                                                                                               |

Full plan and review: `~/.claude/plans/i-m-building-a-missed-enquiry-soft-finch.md`.

---

## Commands

```bash
pnpm install                 # first run; also after pulling
cp .env.example .env         # then set SESSION_SECRET: openssl rand -base64 32

pnpm db:up                   # Postgres + Redis (docker compose)
pnpm db:check                # asserts Redis appendonly=yes, maxmemory-policy=noeviction
pnpm prisma migrate dev      # create + apply a migration
pnpm prisma generate         # regenerate the client after a schema edit

pnpm dev                     # api + web in parallel
pnpm dev:api                 # API only          → http://localhost:3101
pnpm dev:worker              # BullMQ worker only (separate process, D7)
pnpm dev:web                 # dashboard only    → http://localhost:3000

pnpm typecheck && pnpm lint && pnpm test && pnpm build   # full sweep
```

Health: `curl http://localhost:3101/health` (liveness) · `/health/ready` (database reachable).

**Environment notes**

- **Node.** `.nvmrc` pins **24**. This machine runs 25.8.0, which Prisma warns about (it supports
  20.19+, 22.12+, 24.x). Everything works today, but 25 is a non-LTS odd release Prisma doesn't test
  against — production should run 24.
- **Ports.** The API is on **3101**, not 3001: 3001 is taken by an unrelated project on this machine.
- **ESLint.** The API is on ESLint 10; `apps/web` is pinned to **9** because `eslint-plugin-react`
  (transitive via `eslint-config-next`) is not yet ESLint 10 compatible.

---

## Current stage

**Week 0 — scaffolding complete.** The skeleton runs end to end: both apps build, 26 tests pass,
Prisma is migrated against a live Postgres, and API and worker both boot from the same module graph.

**No product code yet.** Two things gate what comes next:

1. **The carrier forwarding test** (`docs/carrier-forwarding-test.md`) is unresolved and is a go/no-go
   on the entire design. If AU carriers don't preserve the original caller's number on a forwarded leg,
   there is nobody to text and the architecture changes.
2. **The D8 tenancy assertion extension is not applied yet.** It lands with `phone_numbers`, the first
   genuinely tenant-scoped model. `businesses` and `users` are the tenant root and are legitimately
   queried unscoped.

Next module order: `auth` → `businesses` → `telephony` → `calls` → `conversations` → `services` →
`leads` → `notifications`.
