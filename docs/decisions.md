# Decisions

Choices that span files. `docs/codebase.md` explains individual files and links here rather than
restating an argument.

One entry per decision: what we chose, what we rejected, and what it costs us. **The rejected
alternative is the important part** — without it, a future session re-proposes it and the reasoning has
to be rebuilt from scratch.

Status: `Locked` (don't relitigate unasked) · `Provisional` (right for now, revisit at a named trigger) ·
`Pending` (open, with the test that resolves it) · `Superseded` (kept, with a pointer to what replaced it).

---

## D1 — Conditional call forwarding, not a new number

**2026-07-27 · Locked**

The business keeps its advertised number. Their carrier forwards unanswered calls to our Twilio number,
using all three GSM conditions (no-reply `**61*`, busy `**67*`, unreachable `**62*`).

**Rejected — issuing a new Twilio number to advertise.** No small business will change the number on
their van, Google Business Profile, website and five years of directory listings. It's the cleanest
technically and unsellable commercially.

**Rejected — porting the existing number.** Maximum control, but porting is slow, irreversible-feeling
to the owner, and makes the pilot a much bigger commitment than it should be.

**Cost:** we depend on carrier behaviour we don't control, and it varies. See D13. Onboarding must set
three codes, not one — missing `**67*` alone loses every declined call, which is most of them.

---

## D2 — Answer, announce, hang up. No voicemail, no recording.

**2026-07-27 · Locked**

Twilio answers the forwarded call, plays one line of TTS naming the business and announcing the incoming
text, then hangs up.

**Rejected — take a voicemail.** It preserves what the business has today, but drags call recording into
the MVP: consent, storage, retention, disclosure, security. All of that for a recording most owners
never listen to.

**Rejected — hang up silently.** Cheapest, but wastes the moment. The caller has just been rung out and
is about to receive a text from an unknown number; the greeting is the only thing that makes that text
legible as legitimate. Expect it to move reply rate more than any copy change.

**Cost:** this _replaces_ the business's voicemail. That's the #1 objection in the sales conversation,
and it must be raised by us before the owner discovers it. Frame honestly: readable leads instead of
voicemails nobody checks. Validate the framing in discovery — if owners refuse, D2 reopens.

---

## D3 — Service catalogue with four pricing types in the MVP

**2026-07-27 · Locked**

Owners configure their own services, each `FIXED` · `STARTING_FROM` · `PER_UNIT` · `MANUAL_QUOTE`, plus
which answers are required before a price may be shown.

**Rejected — no pricing at all (the original plan).** Would have made us feature-equivalent to a
GoHighLevel missed-call workflow that AU agencies resell at ~A$97/mo, while charging A$199+.

**Rejected — the full beds × baths × carpet × suburb matrix now.** Building a pricing model before
knowing how these businesses actually quote is the expensive kind of guess. It arrives post-pilot as a
fifth `MATRIX` type, built from real override data.

**Cost:** the build phase goes from ~4 weeks to ~6. Accepted deliberately — it's the difference between
selling a commodity and selling a quoting product.

---

## D4 — The model never produces a price

**2026-07-27 · Locked**

The LLM returns `{ serviceId, fieldValues }` only. Every currency figure comes from `PriceCalculator`
computing over the owner's stored config.

**Rejected — letting the model quote from context.** Faster to build, and wrong in a way that reaches
customers. A model that can state a price can also be talked into a discount: _"my last cleaner charged
$200, can you beat it?"_ is an invitation a helpful assistant accepts. That's a binding-looking
representation made on the business's behalf, with ACL exposure attached.

**Enforced by test**, not by policy: no outbound message may contain a currency pattern not traceable to
a `PriceCalculator` result, including the adversarial case above.

---

## D5 — A call is not a lead

**2026-07-27 · Locked**

`leads` are created lazily, on the customer's **first reply**. Calls that never get a response stay as
`calls`.

**Rejected — creating a lead per missed call.** It fills the owner's inbox with spam callers and
non-responders, which trains them to ignore it. It also makes "% of missed callers who become qualified
leads" uncomputable, and that's the metric the whole pilot rests on.

---

## D6 — The owner's primary surface is SMS, not the dashboard

**2026-07-27 · Locked**

A structured lead SMS with a magic link goes to the owner within 60 seconds. The dashboard is where they
review and act, not where they find out.

**Rejected — dashboard-first with an SMS ping.** More conventional and easier to demo, but a cleaner
mid-job will not open a web app. The moment speed matters is exactly the moment they're least likely to.

**Cost:** the lead SMS costs a segment every time. Accepted — it's the product.

---

## D7 — One NestJS codebase, two entrypoints

**2026-07-27 · Locked**

`main.ts` (HTTP) and `worker.ts` (BullMQ). Same modules, same image, different start command.

**Rejected — a separate `apps/worker` package.** Duplicates bootstrap, config and DI wiring, and drifts
from the API within weeks. There's no deployment benefit at this scale that a start command doesn't
already give.

---

## D8 — Assert tenancy scoping; don't auto-inject it

**2026-07-27 · Locked**

A Prisma extension throws when a query on a tenant model has no `businessId`. One explicit escape hatch,
`prisma.unscoped()`.

**Rejected — an extension that silently adds `where: { businessId }`.** It hides missing scoping instead
of surfacing it, so it fails _open_ on the first query it doesn't cover. And it can't work for Twilio
webhooks or job processors, where the tenant comes from a phone-number lookup or `job.data` rather than
a session — auto-injection from an empty session would scope to nothing.

**Cost:** more explicit `businessId` arguments in service signatures. Worth it.

---

## D9 — API and dashboard share one registrable domain

**2026-07-27 · Locked**

`app.yourdomain.com` and `api.yourdomain.com`, session cookie on `.yourdomain.com`, `SameSite=Lax`.

**Rejected — `*.vercel.app` + `*.railway.app`.** Two different registrable domains make the session
cookie cross-site, requiring `SameSite=None`, which Safari's ITP blocks. Auth then works on a developer
laptop and fails for a customer on an iPhone — and the fix costs every live session.

---

## D10 — No MMS; photos via a tokenised web link

**2026-07-27 · Locked**

**Rejected — MMS photo collection.** US$0.35 each way and unreliable on AU carriers. A web upload link
is cheaper, more reliable, and gives us file-type validation we don't get from MMS.

---

## D11 — Numeric mobile sender, never an alphanumeric sender ID

**2026-07-27 · Locked**

**Rejected — a branded alphanumeric sender ID.** It cannot receive replies, which makes a two-way
qualification flow impossible. It also now requires ACMA registration (in force 1 July 2026), and
unregistered IDs are flagged "Unverified" or blocked.

**Cost:** the SMS arrives from a number the caller doesn't recognise. Mitigated by naming the business in
the first ~25 characters and by the voice greeting announcing the text (D2). Reply rate is the pilot's
primary metric partly because of this.

---

## D12 — One file per step, with a written explanation

**2026-07-27 · Locked**

Each step touches exactly one file and appends an entry to `docs/codebase.md`. Work stops for review
before the next file.

**Rejected — building a module at a time.** Faster to produce, but the point here is that the owner of
this codebase understands it, not that it exists.

**Cost:** more round trips. Overridable per message (_"do steps 2–4"_).

---

## Pending

| #       | Question                                                                        | Resolved by                                                                                                               |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **D13** | Do AU carriers preserve the original caller's number on a forwarded leg?        | `docs/carrier-forwarding-test.md`. **Go/no-go on D1 and the whole architecture.** If they don't, there is no one to text. |
| **D14** | Do these businesses actually quote sight-unseen often enough for D3 to pay off? | Discovery calls + the weeks 1–2 concierge pilot. If most work is `MANUAL_QUOTE`, D3's scope was misjudged.                |
| **D15** | Hosting: Railway vs Render vs AWS.                                              | Needs the persistent-Redis and `noeviction` requirements checked per provider before committing.                          |
| **D16** | Commercial pricing tiers.                                                       | Deliberately deferred until three paying pilots. Tiers before evidence are theatre.                                       |
| **D17** | Do owners accept losing voicemail?                                              | Discovery calls. A refusal reopens D2.                                                                                    |
