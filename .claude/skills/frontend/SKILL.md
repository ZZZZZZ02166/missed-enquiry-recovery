---
name: frontend
description: Next.js dashboard conventions — app-router structure, server vs client components, the magic-link exchange, session cookie and the same-site domain requirement, talking to the NestJS API, mobile-first layout for an owner holding a phone on a job site, en-AU currency and timezone formatting, tap-to-call actions, and Playwright coverage. Use when adding or changing anything under apps/web, building a page or component, wiring auth on the web side, fetching from the API, or formatting money, dates or phone numbers for display.
---

# Frontend — Next.js dashboard

**Who this is for.** A cleaner or tradie holding a phone, outdoors, between jobs, one-handed. They
arrived by tapping a magic link in an SMS. They will not log in, will not use a laptop, and will close
the tab in under a minute.

The dashboard is the **review** surface. The lead SMS is the primary one (`CLAUDE.md`, locked
decisions). Design accordingly: this is not where the product happens, it's where the owner checks and
acts.

---

## 1. The cookie domain requirement — decide this before anything else

The API and the dashboard **must share a registrable domain**:

```
app.yourdomain.com   → Next.js
api.yourdomain.com   → NestJS
cookie: Domain=.yourdomain.com; HttpOnly; Secure; SameSite=Lax
```

The distinction people get wrong: **same-site is not same-origin.** `app.yourdomain.com` calling
`api.yourdomain.com` is cross-_origin_ but same-_site_ — same registrable domain — so a `SameSite=Lax`
cookie **is** sent. You still need CORS (`Access-Control-Allow-Credentials: true`, explicit origin, not
`*`) and `credentials: 'include'` on the fetch, but the cookie itself works.

Deploy the dashboard to `*.vercel.app` and the API to `*.railway.app` and you have two different
registrable domains. Now the cookie is cross-site, requiring `SameSite=None; Secure` — a third-party
cookie, which Safari's ITP blocks outright and Chrome increasingly restricts. Auth then works on your
laptop and fails for a customer on an iPhone.

**Point real subdomains at both hosts from day one.** Retrofitting this after the pilot means reissuing
every session.

---

## 2. Next.js never touches the database

All logic and authorization live in NestJS. The dashboard renders and calls the API — no Prisma, no
direct Postgres, no duplicated business rules.

- **Server Components** are the default. Fetch server-side, forwarding the incoming cookie.
- **Client Components** only where interaction demands it (`'use client'`): status buttons, the reply
  box, the services editor. Keep them small and at the leaves.
- **Mutations go to the NestJS API**, not to Server Actions that reimplement logic. A Server Action is
  acceptable as a thin pass-through if you want progressive enhancement, but the validation and the
  tenancy check happen in one place only.
- One typed API client in `lib/api.ts`. Never scatter raw `fetch` calls — the cookie forwarding and
  error handling need to be in exactly one place.

```ts
// server component
const res = await fetch(`${API_URL}/leads`, {
  headers: { cookie: (await cookies()).toString() },
  cache: 'no-store', // lead data is never cacheable
});
```

---

## 3. The magic-link exchange

```
/l/[token]  →  POST /auth/magic-link  →  Set-Cookie  →  redirect('/leads/:id')
```

- Exchange happens **server-side**, in a route handler or server component. The token must never reach
  client JavaScript.
- **Redirect immediately after exchange.** Leaving the token in the visible URL leaks it into browser
  history, and into `Referer` on any outbound link from that page.
- Single-use and short-TTL are enforced by the API (`backend` skill §3). The web side just must not
  re-submit on refresh — redirect, don't render.
- An expired or consumed token gets a plain page with a "text me a new link" button. Not a login form:
  the owner has no password, and offering one is a dead end.

---

## 4. Screens in the MVP

| Route                | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `/l/[token]`         | Magic-link exchange, then redirect                                     |
| `/leads`             | Inbox — filterable by status, newest first                             |
| `/leads/[id]`        | **The screen that matters.** Details, SMS thread, reply, status, quote |
| `/settings/services` | The service catalogue and pricing — our differentiator                 |
| `/settings/messages` | Templates, business hours, after-hours behaviour                       |

Nothing else ships in the MVP. No analytics page (a strip of numbers on `/leads` is enough), no staff
management, no billing.

### `/leads/[id]` — design notes

The owner opens this from an SMS, mid-job. In priority order:

1. **Tap-to-call is the primary action.** `<a href="tel:+614...">` — the fastest path to winning the job
   is the owner's voice on the phone. It sits at the top and is thumb-reachable.
2. **Tap-to-text** as secondary — `sms:` link, prefilled.
3. **Collected details** above the message thread. The parsed record is the product; the raw thread is
   evidence.
4. **The quote**, if one was shown, with what the customer was told and when.
5. **One-tap Won / Lost.** This is the only path to the ROI numbers the renewal conversation depends on
   (a lost lead needs no amount; a won one prompts for a dollar figure and nothing else). Every extra
   field here costs completion rate, and an empty ROI dashboard at renewal is a churn event.

---

## 5. Mobile-first, literally

- Design at 375px and scale up. Desktop is the afterthought here, not the default.
- Minimum 44px tap targets. Primary actions in the lower half of the screen — that's what a thumb
  reaches one-handed.
- Assume a slow, flaky connection. Stream with Suspense; show content as it arrives rather than blocking
  the page on the slowest query.
- Optimistic UI on status changes, with rollback on failure. A spinner between tapping "Won" and seeing
  it register is enough friction to lose the habit.

---

## 6. Formatting — en-AU, and the business's timezone

```ts
// Money — always from integer cents, always GST-inclusive when shown (CLAUDE.md rule 11)
new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);

// Dates — the business's timezone, never the browser's
new Intl.DateTimeFormat('en-AU', {
  timeZone: business.timezone,
  dateStyle: 'medium',
  timeStyle: 'short',
});
```

Using the browser's timezone looks correct until an owner checks leads from Bali and every appointment
time shifts. Take the timezone from the business record (`CLAUDE.md` rule 12).

Phone numbers: display in AU national format (`0412 345 678`), but `tel:` and `sms:` hrefs use **E.164**
— national format fails when the handset is roaming.

Relative times ("4 min ago") for anything under an hour; absolute after that. Speed is the product, so
recency should be legible at a glance.

---

## 7. Environment and secrets

- `NEXT_PUBLIC_*` is **shipped to the browser**. Only the API base URL belongs there.
- No API keys, no Twilio credentials, no signing secrets in the web app under any prefix. The dashboard
  authenticates as a user via cookie; it has no service credentials of its own.
- Validate env at startup and fail loudly. A missing `API_URL` should crash the boot, not produce blank
  pages at runtime.

---

## 8. Testing

Playwright over three flows, because these are the ones whose failure means the product doesn't work:

1. **Magic link → lead detail.** Including expired and already-consumed tokens.
2. **Reply from the dashboard → message appears in the thread.**
3. **Status change → persists across reload.**

Plus one tenancy check from the browser's side: authenticated as business A, navigate directly to
business B's lead URL, assert a not-found page rather than data.

Run at mobile viewport by default. A suite that only passes at 1280px is testing a screen nobody uses.
