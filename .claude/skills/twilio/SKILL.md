---
name: twilio
description: Twilio voice, SMS and Lookup for the missed-call recovery flow — webhook signature validation, idempotency, TwiML, delivery status, opt-out and error 21610, geo permissions, GSM-7 segment budgeting and SMS copy rules, and testing telephony without a phone. Use when touching anything under telephony/, writing or changing an outbound message template, handling a Twilio webhook, buying or configuring a number, or debugging a failed/undelivered SMS or a signature validation failure.
---

# Twilio

Everything here is specific to this product: **Australian numbers, forwarded inbound calls, two-way SMS
qualification.** Assumes the locked decisions in `CLAUDE.md` — no voicemail, no recording, no MMS.

---

## 1. The voice flow: answer, announce, hang up

A missed call reaches us because the business's carrier forwarded it. Twilio sees an ordinary inbound
call:

| Param           | Value                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `From`          | the original caller — **verify per carrier**, this is the go/no-go assumption (`docs/carrier-forwarding-test.md`)               |
| `To`            | our Twilio number                                                                                                               |
| `ForwardedFrom` | the business's number _when the carrier supplies a diversion header_ — inconsistently populated on AU PSTN. Never depend on it. |
| `CallSid`       | idempotency key for the call                                                                                                    |

Respond immediately with TwiML. One line, then hang up:

```xml
<Response>
  <Say voice="Polly.Nicole" language="en-AU">
    Thanks for calling Melbourne Sparkle Cleaning. Sorry we can't take your call — we're texting you
    right now so we can help.
  </Say>
  <Hangup/>
</Response>
```

- `Polly.Nicole` is en-AU female (`Polly.Russell` is male). Verify the voice is enabled on the account
  before relying on it; an unavailable voice silently falls back and sounds American.
- **No `<Record>`, no `<Voicemail>`, ever.** Recording drags in consent, storage, retention and
  disclosure obligations we deliberately avoided.
- The greeting names the business and announces the text. Both matter: it's the caller's only signal
  that the incoming SMS from an unknown number is legitimate.
- Do **not** send the SMS from inside this handler — see §3.

Also handle inbound calls **to the SMS number** (callers ring back the number that texted them). Forward
to the business or play a message. Never let it fail.

---

## 2. Webhook signature validation

Twilio's algorithm for form-encoded POSTs (all voice and messaging webhooks):

1. Take the **full URL** Twilio called, including query string.
2. Append each POST param, sorted alphabetically by key, as `key + value` with no separator.
3. HMAC-SHA1 with the auth token, base64.
4. Compare against `X-Twilio-Signature`.

```ts
import { validateRequest } from 'twilio';
validateRequest(authToken, signature, url, req.body); // req.body = parsed form params
```

**The failure mode is almost always URL reconstruction, not the body.** Behind Railway / Render / ngrok,
`req.protocol` is `http` while Twilio called `https`, so the reconstructed URL differs and every
signature fails with no useful error.

```ts
app.set('trust proxy', 1);
// then build from x-forwarded-proto + host + originalUrl, or pin the public base URL in env
```

Pinning `PUBLIC_API_URL` in env and building the URL from that is more predictable than trusting headers.
Whichever you choose, log the reconstructed URL on failure — otherwise this costs an afternoon.

Other requirements:

- The `urlencoded` body parser must have run; `req.body` must be the parsed params.
- Configure `rawBody: true` on the Nest app. Not needed for form-encoded webhooks, but required for
  Twilio payloads that arrive as JSON with a `bodySHA256` query param, and for Stripe later. Cheap
  insurance.
- Reject on failure with **403 and no body**. Never fall through to processing.
- Validation must run **before** anything with a side effect.

---

## 3. Webhook contract: validate → persist → enqueue → return

Twilio times out around 15 seconds and retries. Handlers must be fast and idempotent.

```
validate signature
  → INSERT INTO webhook_events (provider, externalEventId, type, payload)   -- unique (provider, externalEventId)
  → on conflict: return 200 immediately, do nothing
  → enqueue BullMQ job
  → return TwiML / 200
```

Never send an SMS, call an LLM, or hit an external API inside the request.

**Idempotency keys:** `CallSid` for voice, `MessageSid` for messaging. Twilio _will_ deliver duplicates —
this isn't defensive programming, it's the documented behaviour. Replaying a payload three times must
produce exactly one call, one SMS, one lead.

Status callbacks arrive out of order. Guard status transitions rather than blindly overwriting:
`queued → sent → delivered`, and `undelivered` / `failed` are terminal.

---

## 4. Lookup before the first send

Call Lookup v2 once per new caller, before the first SMS:

```ts
const n = await client.lookups.v2.phoneNumbers(e164).fetch({ fields: 'line_type_intelligence' });
n.lineTypeIntelligence?.type; // mobile | landline | voip | fixedVoip | nonFixedVoip | tollFree | ...
```

- Skip the send for `landline` and toll-free — the SMS fails and we're still billed. Write a
  `suppressions` row with reason `landline` so we don't look it up again.
- ~US$0.008 per lookup. Cache the result on `customers`; never look up the same number twice.
- **Withheld / anonymous caller ID** never reaches Lookup — detect it first (empty, `anonymous`, or a
  non-E.164 placeholder) and record the call without a send.

---

## 5. Opt-out, and error 21610

Twilio auto-handles standard keywords (`STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`) and maintains its
**own** opt-out list per sending number. After a STOP, further sends are rejected with:

> **21610** — Attempt to send to unsubscribed recipient

This means our database can believe a number is fine while Twilio blocks it. So:

- Write our own `suppressions` row on the inbound STOP webhook (don't rely solely on Twilio's list).
- **Catch 21610 on send and back-fill a suppression row.** It's the authoritative signal that the two
  lists diverged.
- Never attempt to bypass or resubscribe programmatically.

`START` / `UNSTOP` resubscribes at Twilio's layer — mirror it by clearing our `opted_out` suppression.

---

## 6. SMS copy rules

Cost is per **segment**, not per message. Encoding decides the segment size:

| Encoding | Single | Per segment when concatenated |
| -------- | ------ | ----------------------------- |
| GSM-7    | 160    | 153                           |
| UCS-2    | 70     | 67                            |

**One non-GSM-7 character switches the whole message to UCS-2.** A curly apostrophe (`'`) pasted from a
doc turns a 1-segment message into 3. This is the single easiest way to triple the SMS bill.

Rules for every outbound template:

- **ASCII apostrophes and quotes only.** No em dashes, no smart quotes, no emoji, no `…`.
- GSM-7 extended characters (`^ { } \ [ ] ~ | €`) count as **two**.
- Assert charset and expected segment count in CI. A template that silently grows to two segments is a
  50% cost increase across every conversation.
- Business name in the first ~25 characters — it's the caller's only trust signal.
- **No offers, discounts or promotions. Ever.** (`CLAUDE.md` rule 10.)
- Opt-out notice on the first message only.
- Never include a currency figure that didn't come from `PriceCalculator` (`CLAUDE.md` rule 2).

---

## 7. Australian specifics

- **Geo permissions.** New accounts have Messaging Geographic Permissions restricted. If Australia isn't
  enabled, every send fails with **21408** — and it looks like a code bug. Check this first on a fresh
  account.
- **Numbers:** one AU local number for voice (~US$3/mo), one AU mobile number for two-way SMS
  (~US$8.25/mo). Verify capabilities before buying — not every number supports both.
- **Sender ID:** we use a numeric mobile number, never an alphanumeric sender ID. AU alphanumeric IDs
  require ACMA registration (in force since 1 July 2026) and can't receive replies. Non-negotiable for
  a two-way flow.
- **Provisioning requires a regulatory bundle** (ABN, address, ID) that can take days to weeks. See
  `docs/twilio-setup.md`.
- **No MMS** — US$0.35 each way and unreliable here. Photos go through a tokenised web upload link.

### Error codes worth recognising

| Code          | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| 21408         | Permission to send to this region not enabled — **geo permissions** |
| 21610         | Recipient unsubscribed (STOP)                                       |
| 21211         | Invalid `To` number — usually an E.164 normalisation bug            |
| 21606         | `From` is not a valid, SMS-capable number on this account           |
| 21614         | `To` is not a valid mobile number — landline that got past Lookup   |
| 30003 / 30005 | Unreachable / unknown handset                                       |
| 30006         | Landline or unreachable carrier                                     |
| 30007         | Carrier filtering — content flagged as spam                         |
| 63038         | Account daily message cap exceeded                                  |

**30007 is the one to watch.** Carrier filtering is silent from the sender's side and correlates with
promotional-looking content. It's an operational reason to keep messages strictly transactional, on top
of the legal one.

---

## 8. Testing without a phone

**Put a `TelephonyProvider` interface in front of the SDK from the first commit.** Two implementations:
real, and fake. Without this, every integration test costs money and needs a handset.

The fake records calls and lets tests assert on them:

```ts
expect(fake.sent).toHaveLength(1);
expect(fake.sent[0].body).toMatch(/Melbourne Sparkle/);
expect(segments(fake.sent[0].body)).toBe(1);
```

**Webhook replay harness.** Capture real Twilio payloads once (voice inbound, message inbound, status
callback), commit them as fixtures, replay into the controllers. This is how signature validation,
idempotency and status ordering get tested without telephony.

Twilio test credentials exist but only cover US magic numbers (`+15005550006` valid,
`+15005550001` invalid) and a limited set of operations — useful for SDK smoke tests, not for our AU
flows. Prefer the fake.

**Local webhooks:** `ngrok` or `cloudflared` + the Twilio CLI. Remember the signature URL must match the
tunnel's public HTTPS URL exactly (§2).

---

## 9. Cost circuit breakers

Not optional, and not a Stage 8 item. A retry loop or replay storm can burn hundreds of dollars
overnight:

- Per-business daily send cap, enforced before the provider call.
- Global kill switch readable at send time.
- Per-`(business, phone)` throttle: one recovery SMS per 24h, so a caller ringing three times in five
  minutes gets one text.
- Alert on cap hit, on 30007 rate, and on send volume anomalies.
- Record `segments` and `costCents` on every `messages` row — margin per customer is derived from it.
