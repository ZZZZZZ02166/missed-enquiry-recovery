# Carrier forwarding test — go/no-go gate

**Status: NOT RUN.** Nothing that depends on the result should be built until this is filled in.

---

## Why this blocks everything

The entire product assumes that when a business's carrier forwards an unanswered call to our Twilio
number, Twilio's `From` parameter holds **the original caller's number**.

If AU carriers instead present the _forwarding party_ — the business's own number — then we have nobody
to text, and the product as designed does not exist. There is no authoritative public answer to this; it
varies by carrier, plan and service type, so it has to be measured.

Cost to find out: about A$15 and an afternoon. Cost of finding out in week 6: the architecture.

---

## What you need

- One Australian Twilio number (voice-capable, ~US$3/mo).
- A Twilio Function pointed at it (below) — logs every parameter and returns valid TwiML.
- Three SIMs: **Telstra, Optus, Vodafone**. Prepaid is fine but note it — forwarding behaviour can differ
  between prepaid and postpaid.
- A fourth phone to call from, with caller ID **not** withheld.

### Capture function

Twilio Console → Functions → create a service, then:

```js
exports.handler = function (context, event, callback) {
  console.log('INBOUND', JSON.stringify(event, null, 2));
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Nicole', language: 'en-AU' }, 'Test call received.');
  twiml.hangup();
  callback(null, twiml);
};
```

Set it as the **A Call Comes In** handler on the number. Parameters appear in the Function logs.

---

## Forwarding codes

Dial these from the SIM under test. `<number>` is the Twilio number in full E.164 (`+61...`).

| Condition   | Set                    | Clear   | Fires when                    |
| ----------- | ---------------------- | ------- | ----------------------------- |
| No reply    | `**61*<number>*11*20#` | `##61#` | Rings out (here: after 20s)   |
| Busy        | `**67*<number>#`       | `##67#` | Caller declines, or line busy |
| Unreachable | `**62*<number>#`       | `##62#` | Phone off / no coverage       |

Check current state with `*#61#`, `*#67#`, `*#62#`.

The `*11*20#` suffix sets the no-reply timer in seconds — valid values are typically 5–30 in 5s steps.
**Test that the timer actually applies**; some carriers ignore it and use a fixed default, which changes
how long a caller waits before our greeting.

---

## Results matrix

Fill in every row. Nine tests: three carriers × three conditions.

| Carrier  | Condition      | `From` = original caller? | `ForwardedFrom` value | `To` correct? | Forwarding leg billed? | Notes |
| -------- | -------------- | ------------------------- | --------------------- | ------------- | ---------------------- | ----- |
| Telstra  | No reply       |                           |                       |               |                        |       |
| Telstra  | Busy (decline) |                           |                       |               |                        |       |
| Telstra  | Unreachable    |                           |                       |               |                        |       |
| Optus    | No reply       |                           |                       |               |                        |       |
| Optus    | Busy (decline) |                           |                       |               |                        |       |
| Optus    | Unreachable    |                           |                       |               |                        |       |
| Vodafone | No reply       |                           |                       |               |                        |       |
| Vodafone | Busy (decline) |                           |                       |               |                        |       |
| Vodafone | Unreachable    |                           |                       |               |                        |       |

### Additional checks

| Check                                                                                | Carrier notes |
| ------------------------------------------------------------------------------------ | ------------- |
| Does the no-reply timer (`*11*20#`) actually apply, or is it ignored?                |               |
| Does **declining** fire busy (`**67*`) or no-reply (`**61*`)?                        |               |
| Is carrier voicemail fully bypassed once forwarding is set?                          |               |
| Prepaid vs postpaid difference?                                                      |               |
| What does the caller hear, and for how long, before our greeting?                    |               |
| Withheld caller ID — what arrives in `From`?                                         |               |
| Cost of the forwarding leg on the business's plan (check the bill, not the brochure) |               |

---

## What each outcome means

**All three carriers preserve the caller's number** → proceed. Record the exact codes per carrier in the
onboarding runbook and move to the concierge pilot.

**Some carriers preserve it** → proceed, but restrict pilot recruitment to those carriers and ask about
the carrier during qualification. Note it as a real constraint on the addressable market, not a detail.

**No carrier preserves it** → stop and redesign. D1 is dead. Options, roughly in order of viability:

1. **Tracking number as a second line.** Advertise a Twilio number on Google Business Profile and the
   website only, keeping the mobile for existing customers. Loses the "change nothing" pitch and only
   catches new-customer calls — but those are the ones worth recovering.
2. **Android companion app** reading the call log. True missed-call detection, no forwarding, no
   voicemail loss. Android-only (iOS blocks call-log access), and asking a tradie to install an app is
   real friction.
3. **VoIP/SIP in front of the business number.** Most control, most onboarding work, effectively a
   port.

---

## Also do while you have the SIMs out

Confirm the **business** is billed for the forwarding leg (it is charged as an outbound call against
their plan) and whether their plan includes it. Most business plans have unlimited standard national
calls, so it's usually $0 — but an owner discovering a surprise phone bill because of us is both a churn
event and a trust event. This number goes in the sales conversation, not the fine print.
