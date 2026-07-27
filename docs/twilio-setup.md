# Twilio setup runbook

Account and console configuration. Code-level patterns live in `.claude/skills/twilio/SKILL.md`.

**Start this in week 0.** AU number provisioning requires a regulatory bundle that can take days to
weeks to approve. Discovering that in week 3 blocks the build.

---

## 1. Account

- [ ] Create the account and **upgrade out of trial**. Trial accounts prepend "Sent from your Twilio
      trial account" to every message, which destroys the first-impression SMS and skews reply-rate
      measurement — the one metric the pilot rests on.
- [ ] Enable two-factor auth on the console login.
- [ ] Set a billing alert well below the point where a runaway loop matters.

## 2. Geographic permissions — do this before writing any send code

New accounts restrict where they can send. If Australia is not enabled, **every send fails with 21408**
and it reads exactly like a code bug.

- [ ] Messaging → Settings → **Geo Permissions** → enable Australia.
- [ ] Voice → Settings → **Geo Permissions** → enable Australia.
- [ ] Disable everything else. It's a spend cap as much as a config: a compromised key can't dial
      premium international numbers that aren't enabled.

## 3. Regulatory bundle (AU)

Australian numbers require an identity bundle before purchase. Prepare:

- [ ] ABN (and ACN if a company)
- [ ] Registered business address, with proof
- [ ] Authorised representative ID
- [ ] Business website or a description of intended use
- [ ] Answer to "are you an ISV assigning numbers to your customers?" — **yes**, that's what this product
      is. Answering no and being found to be reselling is worse than the extra questions.

Submit early. Approval is not instant and is the critical path for everything downstream.

## 4. Numbers

| Purpose | Type | Approx. cost |
|---|---|---|
| Inbound forwarded calls | AU local, voice-capable | ~US$3/mo |
| Two-way SMS | AU mobile, SMS-capable | ~US$8.25/mo |

- [ ] **Verify capabilities before buying.** Not every AU number does both voice and SMS, and the
      inventory changes.
- [ ] One number pair per business for the pilot. Do not share a number across businesses — opt-outs,
      reply routing and caller trust all break.
- [ ] Never buy an alphanumeric sender ID (D11).

## 5. Webhook configuration

Per number:

| Event | URL | Method |
|---|---|---|
| Voice — a call comes in | `https://api.<domain>/webhooks/twilio/voice/incoming` | POST |
| Voice — status callback | `https://api.<domain>/webhooks/twilio/voice/status` | POST |
| Messaging — a message comes in | `https://api.<domain>/webhooks/twilio/messages/incoming` | POST |
| Messaging — status callback | set per-message via `statusCallback` | POST |

- [ ] Set the **primary handler fallback URL** too. Without it, a deploy blip means the caller hears a
      Twilio error tone instead of our greeting.
- [ ] URLs must be HTTPS and must match exactly what the app reconstructs for signature validation —
      pin `PUBLIC_API_URL` in env rather than trusting proxy headers (`twilio` skill §2).
- [ ] Inbound calls to the **SMS** number need a handler too. Callers ring back the number that texted
      them; that must not fail.

## 6. Credentials

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...          # required for signature validation — cannot be replaced by an API key
TWILIO_API_KEY_SID=SK...       # use for outbound API calls
TWILIO_API_KEY_SECRET=...
PUBLIC_API_URL=https://api.<domain>
```

- **API keys for outbound calls, auth token only for signature validation.** Keys can be revoked
  individually; the auth token cannot without breaking validation everywhere.
- Rotate keys when anyone leaves the project.
- Never in `NEXT_PUBLIC_*`, never in the web app at all (`frontend` skill §7).

## 7. Usage triggers — the account-level circuit breaker

Console → Monitor → **Usage Triggers**. These are separate from, and a backstop to, the application-level
caps in the `queues-redis` skill.

- [ ] Daily spend above expected × 2 → email alert
- [ ] Daily SMS count above expected × 3 → email alert
- [ ] Monthly spend hard ceiling → alert

A retry loop can burn hundreds of dollars overnight. Application caps are the primary defence; these
catch the case where the application is the thing that's broken.

## 8. Before going live with a real business

- [ ] Test call from each of the three carriers reaches the webhook (`docs/carrier-forwarding-test.md`)
- [ ] Signature validation passing in the deployed environment, not just locally
- [ ] STOP → suppression written → next send blocked
- [ ] Landline caller → Lookup blocks the send, call still recorded
- [ ] Three calls in five minutes → one SMS
- [ ] Fallback URLs configured
- [ ] Usage triggers armed
- [ ] Offboarding instructions written (`##61#`, `##67#`, `##62#`) — a cancelled business whose calls
      hit a dead line is the worst possible failure

---

## Local development

```
ngrok http 3000          # or cloudflared tunnel
```

Set the tunnel URL as the webhook target **and** as `PUBLIC_API_URL` — signature validation compares
against the URL Twilio actually called, so a mismatch fails every request with no useful error.

`twilio-cli` is useful for replaying webhooks and tailing logs:

```
twilio phone-numbers:update <sid> --sms-url=<tunnel>/webhooks/twilio/messages/incoming
twilio debugger:logs:list
```
