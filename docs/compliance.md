# Compliance

**Not legal advice.** This is our working position and the reasoning behind it. Get Australian legal
review before commercial launch — specifically on the Spam Act position (§1), the sender/controller
split (§2), and the quote wording (§5).

Current as at 2026-07-27.

---

## 1. Spam Act 2003 — our position

The Act governs **commercial electronic messages** and requires consent, accurate sender identification,
and a functional unsubscribe facility.

**Our argument that the recovery flow sits outside "commercial":** the caller initiated contact seconds
earlier by ringing the business. The reply is a transactional response to their own enquiry, not a
marketing message. It offers nothing and promotes nothing.

That argument only holds if the messages stay transactional. So:

> **Hard rule: no offers, no discounts, no promotions, no upsells in the recovery flow. Ever.**
> (`CLAUDE.md` rule 10.)

One promotional sentence converts every message in the thread into a commercial electronic message and
retrospectively changes our consent position. This is why the rule is absolute rather than a guideline.

**We comply belt-and-braces anyway**, because the cost is one line of text and the downside is
regulatory:

- Business name in the first ~25 characters of message one — satisfies sender identification, and it's
  also the caller's only trust signal (D11).
- Opt-out notice on the first message.
- STOP honoured immediately, not within the five working days the Act allows.

There is a second, independent reason to keep messages plain: Twilio error **30007** is silent carrier
filtering, and it correlates with promotional-looking content. The legal and operational arguments point
the same way.

---

## 2. Who is the sender

Both the business **and** the party causing a message to be sent can carry liability. The contract must
establish:

- The **business is the sender and data controller**. We are a processor acting on their instruction.
- The business **warrants** it has an appropriate basis for messages sent on its behalf, and indemnifies
  us.
- We may suspend the service if we believe messages are being used for marketing.

Without this, an owner who edits their template into an advertisement creates our problem as well as
theirs.

---

## 3. Sender ID

The ACMA SMS Sender ID Register has been in force since **1 July 2026**. Unregistered alphanumeric
sender IDs are flagged "Unverified" and may be blocked by carriers.

**We don't use alphanumeric sender IDs at all** (D11) — they can't receive replies, which rules them out
for a two-way flow. This sidesteps the register entirely. Do not "improve" branding by adding one.

---

## 4. Privacy

**Status.** The Privacy Act's small business exemption (turnover under A$3M) has **not** been removed —
that's the Tranche 2 reforms, expected 2026–27, not yet introduced as a Bill. Separately, real estate
agents are covered from 1 July 2026 regardless of turnover, which matters for our expansion list.

**Our posture: build to the Australian Privacy Principles from day one**, exemption or not. Three
reasons: the exemption is on a announced path to removal; we'll eventually sell to buyers who ask; and
retrofitting privacy into a system holding two years of customer conversations is far more expensive
than building it in.

**In practice:**

| Principle                           | What we do                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Collect only what's needed          | Only fields required to quote or route the job. No date of birth, no ID, no payment details.                         |
| Never collect sensitive information | No health, no biometric, no government identifiers. Health-adjacent industries stay off the roadmap for this reason. |
| No call recording                   | (D2) Metadata only: from, to, start, end, outcome, provider SIDs.                                                    |
| Transparency                        | Published privacy policy naming subprocessors (§6).                                                                  |
| Access control                      | Tenant isolation enforced in code (D8), least privilege on infrastructure.                                           |
| Encryption                          | TLS in transit; encryption at rest on database and object storage.                                                   |
| Retention                           | See §7.                                                                                                              |
| Breach response                     | Documented plan; notify affected individuals and the OAIC where an eligible breach is likely to cause serious harm.  |

**Access, correction and deletion (APP 12/13).** A real process, not a policy paragraph: a caller can
request their data or its deletion. Needed — an email address that reaches a human, a documented lookup
by phone number, and a deletion path that leaves messages/leads consistent. Build it before the pilot,
not after the first request.

---

## 5. Consumer law and prices

Showing an automatic price is a **representation**, and it's the highest-exposure thing this product
does.

- **Single-price rule: prices quoted to consumers must be GST-inclusive.** Owners will enter prices
  ex-GST without thinking. `businesses.pricesIncludeGst` records how they entered it; the caller-facing
  figure is always GST-inclusive (`CLAUDE.md` rule 11).
- **Estimates must read as estimates.** `PER_UNIT` and `STARTING_FROM` wording says the business will
  confirm the final price. `FIXED` does not, so `FIXED` is only for jobs the owner will genuinely honour
  at that number.
- **Never a price the owner didn't configure** (D4). A model-generated or negotiated figure is a
  misleading representation made on the business's behalf.
- **Snapshot every quote** (`leads.quoteSnapshot`). When prices change next month, we can still show
  exactly what the customer was told and when. This is the evidence in a dispute.

---

## 6. Subprocessors

Name these in the privacy policy and keep the list current:

| Processor          | Purpose                       | Data                                          |
| ------------------ | ----------------------------- | --------------------------------------------- |
| Twilio             | Voice and SMS                 | Phone numbers, message content, call metadata |
| _(hosting — D15)_  | Application and database      | All application data                          |
| _(object storage)_ | Customer photos               | Uploaded images                               |
| _(LLM provider)_   | Field extraction from replies | Message text                                  |
| Sentry             | Error monitoring              | Scrub PII before send                         |

**The LLM row deserves attention.** Customer message text leaves our infrastructure. Check the
provider's data-retention and training terms, disclose it, and never send more of the conversation than
extraction requires.

---

## 7. Retention

| Data                       | Retention                                | Why                                                            |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Messages and conversations | 24 months from last activity             | Dispute evidence and repeat-customer context                   |
| Call metadata              | 24 months                                | Same                                                           |
| Leads                      | Life of the business account + 12 months | The owner's own records                                        |
| Attachments (photos)       | 12 months                                | Storage cost, and lower value over time                        |
| Suppressions / opt-outs    | **Indefinite**                           | Deleting an opt-out re-enables messaging someone who said stop |
| Webhook events             | 90 days                                  | Idempotency only — no value after that                         |

Opt-outs are the deliberate exception to data minimisation: keeping them is what honours the request.

---

## 8. Offboarding

When a business cancels, their carrier is still forwarding calls to us. Disabling the number silently
sends their customers to a dead line.

- Keep answering for **30 days** with "please call us on our main line."
- Send written instructions to clear all three codes: `##61#`, `##67#`, `##62#`.
- Confirm forwarding is cleared before releasing the number.

This is a safety obligation, not a courtesy — the failure lands on their customers, not on them.
