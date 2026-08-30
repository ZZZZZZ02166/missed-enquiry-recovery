# Interview script — Nitrosend, Junior Ruby on Rails Developer

For the first interview with Kam Low (CTO). Everything here is drawn from the missed-enquiry recovery
platform in this repo, mapped onto Nitrosend's stack.

**How to use this:** read sections 1, 2 and 8 the morning of. Sections 3–5 are the stories — know two
of them cold rather than all six loosely. Section 7 is what they said they scrutinise most.

**Every story carries the files to open.** If you get a screen share, have the repo up and go to the
code as you talk — "let me show you" lands far harder than "let me tell you". Line numbers are accurate
as of this commit; if the code has moved, search for the function name instead. Section 12 is the whole
file map on one page, for when you need to find something fast under pressure.

---

## 0. Three things to get right before you say anything technical

**1. Lead with the AI tooling, do not hide it.** Their job ad lists "regular use of AI agents when
building software" as something they *want*. Say up front: *"I built this with Claude Code driving the
implementation, and I'll be specific about where I directed it and where I caught it being wrong,
because that's the actual skill."* Hiding it and getting caught is fatal; owning it is exactly the
profile they advertised for.

**2. You are a junior applying to a startup that says product sense matters more than coding ability.**
Every story below has a "why this mattered to the business" line. Use it. A junior who says *"a wrong
price is worse than no price, so I made the system refuse"* is more interesting than one who recites a
design pattern.

**3. Do not overclaim.** You did not write a Rails app. Say: *"This is TypeScript and NestJS, not Rails
— but the problems are the same ones, and here's how I'd do each of them in Rails."* Then be right about
the Rails part. Section 6 is the translation table.

---

## 1. The 60-second version

> I built a missed-call recovery platform for Australian service businesses. When a cleaner or a
> tradesperson misses a call, the system texts the caller back within 60 seconds, has a short
> conversation over SMS to work out what they need, gives them a price if the business has configured
> one, and hands the owner a structured lead by text with a one-tap login link.
>
> Backend is NestJS on Postgres with Redis-backed background jobs, Twilio for voice and SMS, and an LLM
> for pulling structured fields out of free-text replies. About 15,000 lines, 16 migrations, 204 tests in
> CI plus a few hundred more integration checks.
>
> The interesting part isn't the happy path — it's that almost all of the work went into the failure
> modes. Messages that don't send, webhooks that arrive twice, an AI that tries to invent a price, and a
> caller who types something you didn't expect.

**If they ask "why did you build it?"** — you saw a real problem: local service businesses lose jobs to
whoever answers first, and a missed call is a lost customer with no record it ever happened.

---

## 2. The architecture, in the order you should draw it

If you get a whiteboard or a screen share, draw this. Talk left to right.

```
  caller
    │  missed call (carrier forwards it)
    ▼
 Twilio ──webhook──► API ──► validate signature
                       │      persist webhook_event   (idempotency)
                       │      enqueue job
                       │      return TwiML  ◄── under 15s, always
                       ▼
                  Redis queue
                       │
                       ▼
                    worker ──► send SMS via Twilio
                       │
    caller replies ────┘
         │
         ▼
   API ──► persist ──► enqueue ──► worker ──► LLM extracts fields
                                      │
                                      ├──► numbered service menu
                                      ├──► PriceCalculator (deterministic)
                                      └──► lead + owner SMS w/ magic link
```

**Files to have open while you draw this:**

| Part of the diagram | File |
| --- | --- |
| Twilio calls in | `apps/api/src/telephony/voice.controller.ts` · `messages.controller.ts` |
| Signature validation | `apps/api/src/telephony/twilio-signature.guard.ts:29` |
| Idempotency record | `apps/api/src/telephony/webhook-events.service.ts` |
| Queue + bounded enqueue | `apps/api/src/jobs/queues.ts:198` |
| The worker's brain | `apps/api/src/jobs/processors/inbound-message.processor.ts` |
| The conversation decision | `apps/api/src/conversations/conversations.service.ts:228` |
| Two entrypoints, one codebase | `apps/api/src/main.ts` and `apps/api/src/worker.ts` |

**Four things to say while you draw it:**

1. **"Validate, persist, enqueue, return."** Twilio times out webhooks at about 15 seconds. You never
   send an SMS or call an LLM inside the request — you write the event down, put a job on the queue, and
   answer immediately. Nitrosend has exactly this with Mailgun and SES delivery webhooks.

2. **"One codebase, two entrypoints."** `main.ts` boots the HTTP server, `worker.ts` boots the job
   processors, same modules, same image, different start command. The Rails equivalent is one app with
   `rails server` and `good_job start` — which is exactly what they run.

3. **"A call is not a lead."** Leads are created lazily, on the customer's *first reply*. Calls that
   never get a response stay as calls. That's a product decision, not a technical one — it keeps the
   owner's inbox honest and makes "what percentage of missed callers became real leads" a number that
   means something.

4. **"Every external event is idempotent."** Unique constraint on `(provider, external_event_id)`.
   Replay the same Twilio payload three times and you get exactly one call, one SMS, one lead.

---

## 3. THE story — "every message either sends or explains the failure"

**This is their first job-ad bullet. Lead with this one.** If you tell one story well tomorrow, make it
this one.

### The bug

A customer replied to our text. The system did four things in order:

1. Ran the AI extraction on their message
2. Wrote the conversation state, including `last_inbound_at = now`
3. Sent the reply SMS
4. Marked the job processed

Step 3 failed — a transient Twilio error. The job retried. But on the retry, step 2's `last_inbound_at`
made the system think *"I've already handled this message"*, so it skipped everything and marked itself
successful.

**Net result: the customer got silence, and every dashboard said the conversation was handled.** No
error, no failed job, no alert. The job succeeded on retry, so nothing landed in the failed set.

### Why it's the worst kind of bug

It's silent *and* self-concealing. The retry — the thing that's supposed to save you — is what reports
success. You only find it when a business owner asks why a customer never heard back, and by then you've
lost the job.

**Show them:** `apps/api/src/jobs/processors/inbound-message.processor.ts`

### The fix: reserve, send, confirm

Instead of writing state and then sending, we write a **reservation** first:

```
1. INSERT a message row: body, to, from, provider_message_id = NULL
2. Send via Twilio
3. UPDATE that row with the provider's message id
```

```
inbound-message.processor.ts:480   the reservation — a row with no provider id yet
inbound-message.processor.ts:505   deliver() — send, then confirm with the sid
inbound-message.processor.ts:576   flushUnsentReplies() — runs before anything new
inbound-message.processor.ts:148   ...called first thing in process()
```

A row with a null `provider_message_id` is a durable statement: *"we owe this person exactly these
words, and we haven't delivered them yet."* If the process dies at any point, that row is still there.
Every inbound job flushes unsent reservations before doing anything new, and a background sweep
re-drives anything older than a few minutes.

### The rule it produced

We wrote it into the project's hard rules:

> **Never write an idempotency marker before the side effect it marks.** Send, then record. Enqueue, then
> mark processed. If the marker genuinely must come first, it has to be a *reservation* the retry can
> find and complete — never a claim that the work is finished.

**Show them:** `CLAUDE.md:80` — rule 13, written into the project's invariants. And the sweep that
catches anything the flush misses: `apps/api/src/jobs/processors/inbound-reconciler.processor.ts:99`.

We'd hit the same shape four separate times: marking a job processed before enqueueing, a status write
clobbering a later one, re-adding a completed job id, and this one.

### How you'd say the Rails version

> In Rails I'd do the same thing with a `messages` table and GoodJob. Create the row in a `pending`
> state, deliver, then update with the provider's message id in a separate write. A recurring GoodJob
> sweeps rows that have been pending for more than a few minutes and re-drives them.
>
> For Nitrosend it maps almost exactly onto email — Mailgun or SES accepts the message and hands back a
> message id, then delivery, bounce and complaint events arrive later by webhook. The row is the source
> of truth for "did this actually go out", not the job.

**The line to land it:** *"The job succeeding is not the same as the email being sent. Those are two
different facts and they need two different records."*

---

## 4. Story two — AI guardrails, for an AI-native product

Nitrosend's whole thesis is *"an AI agent performs most of the work through prompts, while the dashboard
is available for human review and control."* So the question they live with every day is: **what must
the agent never be allowed to do?** You have a concrete answer.

### The rule

**The model never produces a price.** It returns `{ serviceId, fieldValues }` and nothing else. Every
currency figure a customer sees is computed by deterministic TypeScript from the business owner's stored
configuration.

### Three layers enforcing it, and why one wasn't enough

**Show them, in this order** — the three layers are three files, which makes the point visually:

```
apps/api/src/conversations/extraction.ts:78      the schema — no currency field exists
apps/api/src/services/quote-message.ts:29        takes a PriceResult, never a number
apps/api/src/services/price-calculator.ts:83     the only thing that computes money
apps/api/src/services/currency-guard.spec.ts:26  the CI guard + its allowlist
CLAUDE.md:58                                     rule 2, stated as an invariant
```

**Layer 1 — the schema has nowhere to put a price.** The extraction JSON schema has no currency field.
A model that tries to quote has nowhere for the number to go, and validation drops it. *An instruction
can be talked around; a schema cannot.*

**Layer 2 — the function signature.** The function that renders a price into a sentence takes a
`PriceResult` object, not a number. There is no parameter anywhere that accepts raw cents. To put a
figure in an outbound message you must first have obtained one from the calculator.

**Layer 3 — a CI test that fails the build.** Layers 1 and 2 make it true *by construction*, which is a
good design and **not a check**. Someone could type `"$50 off"` into a template next month and every
existing test would pass. So:

- A static scan of every source file: no module outside the two pricing modules may contain a `$`
  followed by a digit, or call the money formatter.
- An adversarial test (`currency-guard.spec.ts:97`): a caller writes *"my last cleaner charged $200, can
  you beat it?"* and the fake model is scripted to return a discount. The assertion is that the reply
  contains neither number and no negotiation language.

**And I mutation-tested the guard** — planted a file with `"save $50"` in it to confirm the guard
actually fails, because a scanner that never matches passes vacuously.

### The transferable idea

> The AI is allowed to *understand*. It is not allowed to *decide* anything with money or legal
> consequences attached. And the boundary between those two has to be structural — a schema shape or a
> function signature — not a line in a prompt, because prompts drift and models change.

**For Nitrosend specifically**, that's a question you can ask them: *"when an agent sends a campaign to a
segment, what's the equivalent boundary? Is there something the agent proposes and a human confirms, or
is it fully autonomous with a guardrail?"* That's a real product question and it shows you're thinking
about their problem, not just yours.

---

## 5. Four shorter stories — pick based on where the conversation goes

### 5a. Deliverability and cost discipline (SMS ↔ email)

SMS has a trap: a message is 160 characters if it's pure GSM-7, but **70 characters** if a single
character falls outside that set. One curly apostrophe pasted from a Word document turns a one-segment
message into three and triples the bill on every send.

**Show them:**

```
apps/api/src/common/gsm7.ts:91          segmentInfo — the charset and segment maths
apps/api/src/common/gsm7.ts:214         gsm7Label — the shared sanitiser (see the bug below)
apps/api/src/notifications/templates.ts:304   assertAllTemplates() — runs at import
apps/api/src/notifications/templates.ts:312   the deliberately worst-case lead it asserts against
CLAUDE.md:63                            rule 5
```

What we did:

- Every fixed message template is asserted for charset and segment count **at module load**, so a bad
  template cannot be deployed — an import can't be skipped the way a test can.
- Owner-entered text (business names, service names) is sanitised in one shared function.
- The owner's lead notification has a hard budget of 3 segments, asserted against a deliberately
  worst-case lead.

**The bug worth telling:** I wrote that sanitiser twice — once for the service menu, once for the quote
wording — and the second copy silently omitted the strip step the first one had already been fixed for.
A business named "Sarah's premium clean ✨" would have made every quote a UCS-2 message. **The fix wasn't
to patch the copy, it was to delete it** and share one implementation.

**Nitrosend mapping:** their equivalent is deliverability — spam scoring, sender reputation, link
wrapping, per-message cost across Mailgun and SES. Same discipline: assert what you can at build time,
because the alternative is discovering it in a customer's inbox.

### 5b. Strict input beats clever input

The system originally used a fuzzy matcher to guess which service a caller meant from free text
("bond clean", "just a tidy up"). It was careful — it refused when ambiguous — but it was still guessing.

We replaced it with a numbered menu:

```
What service do you need? Reply with one number only.

1. End-of-lease cleaning
2. Regular house cleaning
3. Deep cleaning
4. Carpet steam cleaning
5. Other
```

And the reply parser became **strict**: the entire trimmed message must be one integer in range.
`two`, `2 please`, `option 2`, `1,3`, `2 bedrooms` are all rejected with a re-prompt.

**Show them:**

```
apps/api/src/services/service-options.ts:265   resolveSelection — the strict parser
apps/api/src/services/service-options.ts:166   buildServiceList — the menu, from the owner's catalogue
apps/api/src/services/service-matcher.ts       the fuzzy version it replaced, kept for the no-menu case
apps/api/src/conversations/conversations.service.ts:236   the early return — a menu reply never reaches the model
```

That last line is worth showing on screen. It's an early return placed *above* the LLM call, so an
unusable reply to a menu cannot cost a model call at all — the property is visible in the control flow
rather than asserted in a comment.

**The thing to say:** *"strictness deleted code rather than adding it."* The loose parser needed a table
of unit words so `"2 bedrooms"` couldn't select option 2, and a comma-splitting rule for `"1,3"`. Both
heuristics disappeared. **A rule with no exceptions needs no exceptions handled.**

The product argument: the failure mode of strictness is one extra text message. The failure mode of a
misread digit is quoting the wrong job at the wrong price.

### 5c. Multi-tenancy — the failure that returns everyone's data

Every query is scoped by `business_id` taken from the authenticated session, never from anything the
client sends. Two mechanisms:

**Show them:**

```
apps/api/src/prisma/tenant-guard.ts:26     TENANT_MODELS — which models must be scoped
apps/api/src/prisma/tenant-guard.ts:67     TenantScopeError
apps/api/src/prisma/prisma.service.ts:49   db = base.$extends(tenantGuard) — guarded by default
apps/api/src/prisma/prisma.service.ts:60   unscoped — the named, deliberate hole
apps/api/src/auth/session.guard.ts:79      @Session() — throws if the guard did not run
CLAUDE.md:56                               rule 1
```

**A database-layer assertion.** The ORM client is extended so that a query against a tenant-scoped model
without a top-level `business_id` **throws**. It caught a bug in my own test last week.

**A guard that fails loudly when absent.** The decorator that reads the tenant off the request throws if
the guard didn't run. That sounds like defensive noise, and it isn't — in most ORMs, `where(business_id:
nil_value)` doesn't error and doesn't filter. It returns **every tenant's rows**. Failing at the
decorator turns a cross-tenant data leak into a 500 in development.

**Rails version, and be honest about the difference:**

> `default_scope` is the tempting answer and I'd avoid it — it's implicit, it leaks into places you
> didn't intend, and `unscoped` silently defeats it. I'd rather make the tenant an explicit object you
> have to go through: `current_business.leads.find(params[:id])` rather than `Lead.find(params[:id])`.
> And I'd add a request spec that logs in as business A, asks for business B's record, and asserts a
> **404, not a 403** — a 403 confirms the id exists, which is an enumeration oracle across tenants.
>
> For real defence in depth, Postgres row-level security with the tenant in a session variable is the
> strongest option, and it's more operational complexity than a startup usually wants on day one.

### 5d. Security instinct — the open redirect I shipped and caught

The owner's lead SMS carries a magic link with a `next` parameter, so tapping it lands on that specific
lead. I validated it with `path.startsWith('/')`.

That passes `//evil.example` — which is a **protocol-relative URL**. A browser resolves it to
`https://evil.example`. A link on *our* domain landing on someone else's login page borrows all of our
credibility. That's the phishing lever exactly.

Now it rejects protocol-relative forms, backslash variants (browsers normalise `\` to `/`), and embedded
schemes like `/javascript:alert(1)`.

**Show them:** `apps/api/src/auth/auth.service.ts:232` — `safeRedirect`, four lines and a comment
explaining each one. The test that caught it is `apps/api/src/auth/auth.http.spec.ts`, and the eight
hostile shapes are in the scratchpad suite.

**The point to make:** *my own adversarial test caught it, not a review.* That's the argument for writing
the hostile cases before you believe your own code.

---

## 6. Translating your stack to theirs

Have this in your head. If you say "in Rails I'd..." and get it right, the TypeScript stops being a
problem.

| What I used | Nitrosend equivalent | Notes to mention |
| --- | --- | --- |
| NestJS module | Rails engine / namespaced concern | Nest is opinionated DI; Rails uses POROs in `app/services` |
| Prisma | ActiveRecord | Prisma migrations ≈ Rails migrations; Prisma is more explicit, AR is more magical |
| **BullMQ + Redis** | **GoodJob + Postgres** | **See below — this is your best point** |
| Nest guard | `before_action` / Pundit policy | |
| DTO + class-validator | Strong params + ActiveModel validations / dry-schema | |
| Jest + supertest | RSpec request specs | |
| `@Injectable()` service | `app/services/foo_service.rb` | |
| Prisma `$extends` tenant assertion | A `TenantScoped` concern, or RLS | |
| Zod schema for LLM output | `dry-schema` or a JSON-schema gem | Same idea: validate at the boundary |

### The GoodJob point — make this one

They use **GoodJob, which is Postgres-backed, not Redis-backed.** This is a genuine technical difference
you can speak to intelligently:

**Show them:** `apps/api/src/jobs/queues.ts:198` (`addJobBounded`), `:225` (`waitForRedisReady`) and
`:142` (`PRODUCER_REDIS_OPTIONS`, where `enableOfflineQueue: false` is set and explained).

> One of the nastiest problems I hit was that with a Redis-backed queue, the enqueue is a **separate
> system from the database**. I had a case where Redis was unreachable and `queue.add()` never resolved
> — it just hung, holding the Twilio webhook open past its timeout, so the caller heard silence. I had
> to add a bounded timeout on every enqueue and a reconciler that sweeps rows that were persisted but
> never got a job.
>
> GoodJob doesn't have that class of problem, because enqueueing is a Postgres INSERT. You can enqueue
> **inside the same transaction** as the row you're writing about. If the transaction commits, the job
> exists; if it rolls back, so does the job. That removes a whole category of "the record says one thing
> and the queue says another" bugs I had to write reconciliation code for.

That answer does three things at once: shows you've operated a queue in anger, shows you understand
*why* their tool choice is different, and gives them a reason to think you'll be productive quickly.

**Also worth knowing:** GoodJob supports cron-style recurring jobs, which is what I'd use for the
reconciliation sweeps described in section 3.

---

## 7. "What would you fix or ship first?" — the question they scrutinise most

They said this is the answer they examined most carefully in applications, so expect it live.

### Do not fabricate

Only describe things you **actually observed** when you tested the product. If you're unsure of a detail,
say *"this is from about twenty minutes in the product, so tell me if I've misread it."* Being corrected
on a real observation is fine. Being caught inventing one is not.

### The structure that works

1. **What I noticed** — specific, concrete, from your own use
2. **Why it matters commercially** — tie it to their revenue, churn, or support load
3. **What I'd do first** — the *smallest* version that proves it, not the grand redesign
4. **How I'd know it worked** — a number

### The answer their own job ad points at

Their first bullet is *"improve the email sending system so every message either sends successfully or
clearly explains the failure."* That's them telling you where the pain is. If your product testing
surfaced anything at all about sends — a failure with an unclear reason, a campaign whose status was
ambiguous, a bounce you couldn't explain — that's your answer, and section 3 is your credibility for it.

Something in this shape, filled in with what you actually saw:

> When I sent a test campaign I couldn't tell from the UI whether [what you observed]. That's the kind of
> thing that generates a support ticket per customer per week, and for a young product every one of those
> is a founder's afternoon.
>
> The first thing I'd ship isn't a redesign — it's making every message row carry an explicit state and a
> human-readable reason. Queued, accepted by the provider, delivered, bounced, failed, plus the provider's
> own reason string surfaced rather than swallowed. Then one screen that lists anything not in a terminal
> state for more than N minutes.
>
> I'd know it worked if "why didn't this send?" stopped arriving in support.

### And a second one, if they push for more

The AI-agent boundary from section 4. *"What is the agent allowed to do irreversibly?"* Sending a
campaign to 50,000 contacts is not undoable. If there isn't already a confirm-before-irreversible-action
boundary, that's the guardrail I'd want to build, and I've built the equivalent for pricing.

---

## 8. Likely questions, and how to answer them

**"This is TypeScript. We're Rails. Convince me."**
> The frameworks are the smaller half. What I've actually spent my time on is idempotent webhook
> handling, background jobs that survive a provider being down, multi-tenancy that doesn't leak, and
> keeping an LLM inside a box. Those are the same problems in Rails, and I've got a concrete answer for
> how I'd do each of them there. I'd expect to be slow on Rails idiom for a couple of weeks and fine on
> the actual problems from day one.

**"How much of this did the AI write?"**
> Most of the typing. I made the architectural decisions and I caught it being wrong repeatedly — it
> shipped a fuzzy service matcher I replaced with a strict numeric one, it wrote a sanitiser twice and
> the second copy had a bug the first one had already been fixed for, and it validated a redirect with a
> check that let `//evil.example` through. My job on this project was to know what "correct" looked like
> and to keep pushing until the code got there. That's the same job with or without the tool.

*(This is the honest answer and it's also the strongest one. They asked for it in the ad.)*

**"What's the hardest bug you've fixed?"** → Section 3. Don't rush it.

**"What are you weakest at?"**
> Rails specifically — I know the concepts, not the idioms, and I'd expect code review to be busy for a
> while. And I've never operated anything at real scale; everything I've built has been correct under
> test rather than proven under load. Which is part of why this role is interesting.

*(Name a real gap. Juniors who claim none read as either dishonest or incurious.)*

**"Have you worked with Twilio?"**
> Yes, voice and SMS. Signature validation is the part that bites — it validates over the URL plus
> alphabetically sorted params, and behind a proxy `req.protocol` reads `http` while Twilio actually
> called `https`, so every signature fails and the error tells you nothing. You pin the public base URL
> in config. Also error 21610 — Twilio maintains its own opt-out list, so after a STOP it rejects sends
> even when your database thinks the number is fine, and you have to catch that and sync it back.

*(This level of specific, scar-tissue detail is what separates "I've used Twilio" from "I've shipped
Twilio.")*

**"Where do you want to be in two years?"**
> Good enough at this that I'm the person who notices the failure mode before it ships. I'd also like to
> get closer to the product side — a lot of what I enjoyed in my own project was deciding what the system
> should refuse to do.

---

## 9. Questions to ask them

Ask two or three. These are chosen to show you've thought about their actual problem.

1. **"Where's the boundary on what the agent can do without a human confirming?"** Sending to a large
   segment isn't undoable — is there a confirm step, or a guardrail, or is it fully autonomous?
2. **"How do you handle Mailgun and SES webhooks arriving twice, or out of order?"** A delivered event
   landing before the accepted event is the shape that catches people.
3. **"Are you enqueueing GoodJob inside the same transaction as the record?"** *(This shows you know why
   Postgres-backed queues matter.)*
4. **"What does the first month look like for the first junior — shadowing, or shipping?"**
5. **"What's the thing that breaks most often right now?"** — the answer tells you what the job actually
   is.

---

## 10. Numbers you can quote

Don't recite these unprompted. Use one if they ask about scale or rigour.

| | |
| --- | --- |
| Tests in CI | 204 |
| Additional integration checks | ~900 across 15 suites |
| Migrations | 16 |
| Tables | 11 |
| Hard rules written into the project | 13 |
| Bugs found by adversarial tests before shipping | ~12 |

**The one worth saying out loud:** *"most of those tests exist because they failed first."* The suites
weren't written to confirm the code worked — several were written to prove a bug existed before it was
fixed.

---

## 11. Final checklist for tomorrow

- [ ] Can you draw section 2's diagram from memory?
- [ ] Can you tell the section 3 story in under three minutes, ending on the rule?
- [ ] Do you have your **real** observations from testing Nitrosend written down?
- [ ] Have you got the GoodJob-vs-Redis point ready? It's your best "I understand your stack" moment
- [ ] Repo open in an editor in case they want to look
- [ ] Two questions from section 9 written on paper
- [ ] Repo open, terminal already in `apps/api`, section 12 map to hand

---

## 12. One-page file map

For when they ask something and you need to find it in ten seconds.

### The stories

| Story | Open this |
| --- | --- |
| Reserve-send-confirm | `apps/api/src/jobs/processors/inbound-message.processor.ts:480` |
| Rule 13 itself | `CLAUDE.md:80` |
| Reconciliation sweeps | `apps/api/src/jobs/processors/inbound-reconciler.processor.ts:99` |
| AI can't price — schema | `apps/api/src/conversations/extraction.ts:78` |
| AI can't price — signature | `apps/api/src/services/quote-message.ts:29` |
| AI can't price — CI guard | `apps/api/src/services/currency-guard.spec.ts:26` |
| The adversarial "$200" test | `apps/api/src/services/currency-guard.spec.ts:97` |
| GSM-7 maths | `apps/api/src/common/gsm7.ts:91` |
| Templates asserted at import | `apps/api/src/notifications/templates.ts:304` |
| Strict numeric parser | `apps/api/src/services/service-options.ts:265` |
| Model skipped for menu replies | `apps/api/src/conversations/conversations.service.ts:236` |
| Tenant guard | `apps/api/src/prisma/tenant-guard.ts:26` |
| `@Session()` throws | `apps/api/src/auth/session.guard.ts:79` |
| Open redirect fix | `apps/api/src/auth/auth.service.ts:232` |
| Bounded enqueue (the Redis problem) | `apps/api/src/jobs/queues.ts:198` |

### The system

| Thing | Where |
| --- | --- |
| Entrypoints | `apps/api/src/main.ts` · `apps/api/src/worker.ts` |
| Twilio webhooks in | `apps/api/src/telephony/voice.controller.ts` · `messages.controller.ts` |
| Signature validation | `apps/api/src/telephony/twilio-signature.guard.ts:29` |
| Webhook idempotency | `apps/api/src/telephony/webhook-events.service.ts` |
| Conversation state machine | `apps/api/src/conversations/conversations.service.ts:228` |
| Pricing | `apps/api/src/services/price-calculator.ts:83` |
| Lead writing | `apps/api/src/leads/leads.service.ts` |
| Owner notification | `apps/api/src/jobs/processors/notify-owner.processor.ts` |
| Auth | `apps/api/src/auth/` (7 files) |
| Schema | `apps/api/prisma/schema.prisma` (11 tables, 16 migrations) |
| Shared validation, both apps | `packages/shared-types/src/service-catalogue.ts` |

### The documentation

| Doc | What it is |
| --- | --- |
| `CLAUDE.md` | The 13 hard rules. **Show them this if they ask how you kept quality up** |
| `docs/codebase.md` | Every file, what it does and *why it's built that way* |
| `docs/decisions.md` | Cross-file decisions, dated, with the rejected alternatives |
| `docs/remaining-plan.md` | What's left, with the debt list |

`docs/codebase.md` is worth a mention on its own: every file got an entry written *at the same time as
the file*, including the bugs found and why the design changed. If they ask "how do you keep a codebase
understandable", that's your answer and it's ~5,000 lines of evidence.

---

## 13. If you get a screen share — a two-minute demo

Don't try to run it live; the database, Redis and Twilio all have to be up. Show **code and tests**
instead — it's more impressive anyway, because it shows the failure modes.

**Option A — the one to default to.** Open `inbound-message.processor.ts`, scroll to the reservation at
line 480, and read the comment above it out loud. It explains the ordering and why the opposite ordering
in `RecoveryProcessor` is also correct. That comment *is* the story.

**Option B — if they like tests.** Run the currency guard:

```bash
cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest src/services/currency-guard.spec.ts
```

Then say: *"and I mutation-tested it — I planted a file with `$50 off` in it to prove the guard actually
fails, because a scanner that never matches passes vacuously."*

**Option C — if they ask about the AI.** Open `extraction.ts:78` and point out that the schema has no
currency field. One sentence: *"the model has nowhere to put a price, so it can't."*

**Have the terminal in `apps/api` and the repo open before the call starts.** Fumbling for a file kills
the momentum of a good answer.

---

**Last thing.** They're hiring their first junior to work directly with the CTO. They're not buying
finished skill — they're buying judgement, curiosity, and whether they'll enjoy the next two years of
code review with you. Be specific, admit what you don't know quickly, and show that you care about the
thing being *right* rather than done.
