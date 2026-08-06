# Build report — steps 92 to 98

Everything implemented on the `finish-backend-and-dashboard` branch, from the CI currency guard through
to a working login in the lead SMS. Nothing from earlier steps is repeated here; for those see
`docs/codebase.md`.

**Result:** rule 2 is enforced by CI, and authentication exists end to end. Jest went from 165 to 204
tests. Seven commits, 11 new files, 6 modified.

---

## Files created

| File | Lines | What it is |
| --- | ---: | --- |
| `apps/api/src/services/currency-guard.spec.ts` | 157 | CI guard: no currency figure escapes `PriceCalculator` |
| `apps/api/prisma/migrations/20260806085634_add_user_auth_fields/migration.sql` | 9 | Five columns on `users`, one index |
| `apps/api/src/auth/tokens.ts` | 149 | Magic-link and session cryptography, pure |
| `apps/api/src/auth/tokens.spec.ts` | 137 | 14 security properties, in CI |
| `apps/api/src/auth/auth.service.ts` | 248 | The authentication boundary |
| `apps/api/src/auth/cookies.ts` | 96 | Cookie parsing and the `Set-Cookie` attributes |
| `apps/api/src/auth/cookies.spec.ts` | 95 | 13 parsing and attribute properties, in CI |
| `apps/api/src/auth/session.guard.ts` | 91 | `SessionGuard` + the `@Session()` decorator |
| `apps/api/src/auth/auth.controller.ts` | 142 | Four HTTP routes |
| `apps/api/src/auth/auth.module.ts` | 28 | Module wiring |
| `apps/api/src/auth/auth.http.spec.ts` | 171 | 9 end-to-end HTTP tests against a real database |

**1,323 lines.** Roughly half is documentation comment, which is the house style — the reasoning is the
part that survives.

## Files modified

| File | Change |
| --- | --- |
| `apps/api/prisma/schema.prisma` | Magic-link and session columns on `users` |
| `apps/api/src/app.module.ts` | Mounted `AuthModule` |
| `apps/api/src/jobs/jobs.module.ts` | Imported `AuthModule` so the notifier can mint links |
| `apps/api/src/jobs/processors/notify-owner.processor.ts` | Mints the magic link for the lead SMS |
| `apps/api/src/notifications/templates.ts` | `magicLink` on the owner message + budget assertion |
| `docs/codebase.md` | Seven build-log rows and seven entries |

---

## Step 92 — rule 2 fails the build

`apps/api/src/services/currency-guard.spec.ts`

**The problem.** "The model never prices" had been true *by construction* for several steps: the
extraction schema has no currency field, and `quoteMessage` takes a `PriceResult` rather than a number.
Both are good designs. Neither is a **check**. A template with `"$50 off"` typed into it, or a new helper
that formats cents somewhere convenient, would have passed every test in the repository.

**Two guards, deliberately different in kind.**

*Static.* Walk every `.ts` file under `src`, strip comments, and fail if any file outside
`price-calculator.ts` and `quote-message.ts` contains a `$` followed by a digit, or calls `formatCents`.
Comments are stripped because a comment explaining "$280 ex-GST becomes $308" is documentation — flagging
it would make the guard noisy enough to be switched off, which is how a rule like this usually dies.

*Behavioural.* The adversarial case from the plan. A caller writes *"my last cleaner charged $200, can
you beat it?"* and the fake model is scripted to return `price: 15000`, `quotedPrice: "$150"` and
`discount: "20%"`. The assertion: the reply contains neither number, no negotiation language, and no
figure but the configured `$280` — and nothing smuggled a price into `collected`.

**Verified by mutation, not by passing.** A guard that scans for a pattern can pass vacuously — a wrong
path, a regex that never matches. Planting a file containing `"Book today and save $50 off your clean."`
plus a `formatCents` call made both guards fail with the file and line named; removing it made them pass.

**The key line:**

```ts
const CURRENCY_ALLOWLIST = new Set([
  'services/price-calculator.ts',   // owns formatCents
  'services/quote-message.ts',      // the only module that composes a sentence with a figure
]);
```

That set is the whole security boundary. Adding to it is a decision about who may render money.

---

## Step 93 — auth columns on `users`

`schema.prisma`, migration `add_user_auth_fields`

Five columns, one index, **no new table** — the locked count of twelve holds.

```sql
ALTER TABLE "users" ADD COLUMN "magic_link_token_hash" TEXT,
                    ADD COLUMN "magic_link_expires_at" TIMESTAMP(3),
                    ADD COLUMN "magic_link_sent_at"    TIMESTAMP(3),
                    ADD COLUMN "session_epoch"         INTEGER NOT NULL DEFAULT 0,
                    ADD COLUMN "last_login_at"         TIMESTAMP(3);
CREATE INDEX "users_magic_link_token_hash_idx" ON "users"("magic_link_token_hash");
```

**Why no `magic_links` table.** One column makes "one active link per user" an invariant of the schema
rather than a rule some query has to remember. Requesting a second link overwrites the first, which is
the behaviour you want anyway — an owner who taps "send me a link" twice should not leave a spare key in
their inbox.

**The token is stored hashed.** The link arrives by SMS and lives in a phone's message history
indefinitely, so it must be single-use and short-lived, and a database read must not yield a working
login.

**`sessionEpoch` is the revocation mechanism.** Sessions are stateless signed cookies — there is no table
to delete rows from. The epoch is embedded in the cookie and compared on every request; incrementing it
invalidates every outstanding session for that user at once. Without it, "log out everywhere" would be a
button that does nothing for thirty days.

---

## Step 94 — the cryptography

`apps/api/src/auth/tokens.ts` · `tokens.spec.ts`

Pure — no Nest, no Prisma, no environment. Everything is passed in, so every security property is
testable without standing anything up, which for this kind of code is the difference between "we believe
this" and "this is checked".

### Two different things, kept apart

| | Magic-link token | Session cookie |
| --- | --- | --- |
| What it is | a random secret sent to a person | a signed statement sent to a browser |
| Stored? | yes, hashed | no |
| Lifetime | 15 minutes, single use | 30 days, revocable |
| Kind | bearer credential | assertion |

Conflating them is how systems end up with sessions that cannot be revoked, or links that never expire.

### Functions

```ts
generateMagicLinkToken(): string          // 32 CSPRNG bytes, base64url
hashMagicLinkToken(token): string         // SHA-256 hex — what the database stores
signSession(claims, secret): string       // "payload.signature", both base64url
verifySession(cookie, secret): SessionVerification
```

**Plain SHA-256 for the link token is deliberate.** This is the one place where "just hash it" is right
rather than lazy. A password needs a slow KDF because it has perhaps 40 bits of entropy and gets reused;
this token has 256 bits from the OS CSPRNG and a fifteen-minute life. There is no dictionary to run and
no reuse to protect, and a slow hash on an unauthenticated endpoint is a denial-of-service amplifier.

**Hand-rolled session token rather than a JWT library.** JWT's flexibility is its weakness — `alg: none`,
algorithm confusion, and a dozen claim conventions nobody validates. Here there is exactly one algorithm,
the verifier never reads one from the token, and the claim set is four fields defined in one file.

**The signature is checked before the payload is parsed.** `JSON.parse` on attacker-controlled bytes is
somewhere to be careful, and there is no reason to go there until the bytes are proven ours. Tested with
a payload that would throw if it were reached first.

**Constant-time comparison, and what it hides.** `a === b` on a signature returns as soon as a byte
differs, and that timing is an oracle an attacker walks one byte at a time. `timingSafeEqual` needs equal
lengths, so a mismatch answers first — leaking only the length, which is fixed for a SHA-256 HMAC and
therefore reveals nothing.

**What the 14 tests prove.** 1000 generated tokens are unique and URL-safe; the hash is deterministic and
does not contain the token; a cookie signed with a different secret is rejected; **claims cannot be
edited** — the real attack is minting a session for one tenant, swapping `businessId`, and reading
another business's leads, and it is tested as exactly that; expiry cannot be extended; the unsigned
`alg: none` shape is refused; malformed input never throws; and a validly signed cookie with structurally
wrong claims is still rejected, which protects against a cookie minted by an older version of this code.

---

## Step 95 — the authentication boundary

`apps/api/src/auth/auth.service.ts`

Magic links in, sessions out. The owner's primary surface is an SMS with a link (D6) — a cleaner on a
roof will not type a password into a phone. So the link *is* the login, which makes this file the entire
authentication boundary: every tenant-scoped query in the product depends on `resolveSession` returning
the right `businessId` or nothing at all.

### `consumeMagicLink` — single use under a race

```ts
const claimed = await this.prisma.unscoped.user.updateMany({
  where: { id: user.id, magicLinkTokenHash: hash },   // <- the claim
  data:  { magicLinkTokenHash: null, magicLinkExpiresAt: null,
           magicLinkSentAt: null, lastLoginAt: new Date() },
});
if (claimed.count === 0) return null;
```

The hash in the `where` clause is what makes this a **compare-and-set** rather than an overwrite. A link
preview fetching the URL a millisecond before the human taps it is the common case, not a hypothetical.
Proven with ten simultaneous consumptions of one token: exactly one wins.

### `resolveSession` — the tenant comes from the database

Two checks. The signature proves the cookie is ours and unmodified; the epoch proves it has not been
revoked since. Then:

```ts
return { userId: user.id, businessId: user.businessId };  // NOT verified.claims.businessId
```

The cookie's copy is signed and would be safe to trust — but if a user is ever moved between businesses,
a signed-but-stale cookie would keep reading the old tenant's data for thirty days. Rule 1 says the
tenant comes from the session; this makes "the session" mean the current state of the world. Tested by
minting a **validly signed** cookie carrying the wrong tenant and asserting the resolved business is the
real one.

### Account enumeration

`requestLinkByEmail` returns null for an unknown address *and* for a link it did mint. A 404 here is an
enumeration oracle, and this product's customers are listed on Google Maps with their business email.

### The security bug this step found

`next` exists so a lead SMS drops the owner on the lead rather than the inbox — which makes it a redirect
target inside an unauthenticated URL, the classic open-redirect surface.

The first implementation validated it with `startsWith('/')`. **That is not enough.** `//evil.example`
starts with a slash and is a *protocol-relative* URL: a browser resolves it to `https://evil.example`. A
link on our own domain landing on somebody else's login page borrows all of our credibility — which is
the phishing lever exactly.

```ts
export function safeRedirect(path: string): string {
  const candidate = (path ?? '').trim();
  if (!candidate.startsWith('/')) return '/';
  if (/^[/\\]{2}/.test(candidate)) return '/';        // //host and browser-normalised variants
  if (candidate.includes('\\')) return '/';
  if (/[a-z][a-z0-9+.-]*:/i.test(candidate)) return '/'; // /javascript:alert(1)
  return candidate;
}
```

Backslashes go because browsers normalise them to slashes, so `/\evil.example` reaches the same place.
Schemes go because `/javascript:alert(1)` is a path by the naive rule and a scheme once a browser strips
the leading slash. Eight hostile shapes are covered by the suite. **My own test caught this**, which is
the argument for writing the adversarial cases before believing the code.

---

## Step 96 — rule 1 becomes enforceable

`apps/api/src/auth/cookies.ts` · `cookies.spec.ts` · `session.guard.ts`

### The guard

Rule 1 — "every query is scoped by a `businessId` taken from the authenticated session" — had **no
mechanism** on the HTTP side. `AuthService` could resolve a tenant; nothing obliged a controller to ask.

`SessionGuard` resolves it once and attaches it to the request. `@Session()` is the only sanctioned way
to read it, and it can only produce what the guard put there. Reading `businessId` from a body or query
param is now something you have to write code that visibly bypasses this file to do. **The wrong thing
has to look wrong.**

### The most important line in the file

```ts
if (!request.session) {
  throw new Error('@Session() was used on a route without @UseGuards(SessionGuard). ...');
}
```

A route decorated with `@Session()` but missing the guard would otherwise hand the controller
`undefined` — and `businessId: undefined` in a Prisma `where` clause **does not error and does not
filter**. Prisma treats an undefined filter as absent, so that route returns *every tenant's rows*.
Failing at the decorator is the difference between a 500 in development and a cross-tenant leak in
production. The HTTP spec tests this directly with a deliberately unguarded route.

### One rejection message

No cookie, bad signature, expired, revoked, deleted user — all `Not authenticated`. Distinguishing them
tells an attacker which of those they achieved.

### Cookie attributes, each load-bearing

| Attribute | Why |
| --- | --- |
| `HttpOnly` | an XSS bug in the dashboard cannot exfiltrate a thirty-day login |
| `SameSite=Lax` | CSRF protection for every mutating route, no token dance |
| not `Strict` | `Strict` drops the cookie on the top-level navigation *from the SMS app* — the owner taps the link and lands logged out |
| `Domain` | the shared registrable domain from D9 |
| `Secure` | derived from `PUBLIC_API_URL`, not `NODE_ENV` |

**`Secure` from the URL, not the environment.** A staging deployment on HTTPS gets the right behaviour
without anyone remembering a flag, and a production deployment misconfigured onto HTTP loses the
attribute loudly rather than silently failing to log anyone in.

**Set and clear are built from one attribute function.** They must be identical apart from value and
`Max-Age`, or the browser treats the clear as a *different* cookie, keeps the original, and logout
becomes a button that appears to work. The spec asserts the attribute sets match.

### A decision reversed mid-step

The first version used the `__Host-` cookie prefix, which is strictly safer — browsers enforce `Secure`,
`Path=/`, and **no `Domain` attribute**, so no sibling subdomain can mint a session. But forbidding
`Domain` contradicts D9, which settled on `app.example.com` plus `api.example.com` sharing a cookie on
the registrable domain, and it would have orphaned the existing `SESSION_COOKIE_DOMAIN` config. Following
the recorded decision rather than silently deviating; the trade-off is written into the file.

**Hand-rolled rather than `cookie-parser`.** One cookie, fifteen lines, and a dependency that would run
on every request including every unauthenticated Twilio webhook. The parsing is the boring part; the
attributes are what matter, and no library would have chosen them for us.

---

## Step 97 — auth is mounted

`auth.controller.ts` · `auth.module.ts` · `app.module.ts`

| Route | Guard | Notes |
| --- | --- | --- |
| `POST /auth/request-link` | none | always 202, identical body either way |
| `GET /auth/callback` | none | consumes the token, sets the cookie, redirects |
| `GET /auth/me` | `SessionGuard` | the dashboard's first call on load |
| `POST /auth/logout` | `SessionGuard` | revokes **every** session for the user |

**`/auth/callback` is a GET that mutates**, which is normally wrong and is right here: the request is a
top-level navigation from an SMS app, and there is no way to make a phone issue a POST by tapping a link.
It is safe because `consumeMagicLink` is a compare-and-set — the link-preview fetch that beats the human
to the URL consumes the token, and the human's tap then fails closed rather than logging somebody in
twice.

**The guard is opt-in, not a global `APP_GUARD`.** A global guard would also cover the Twilio webhooks,
which authenticate by signature rather than cookie, so they would need a `@Public()` opt-out — and
**opt-out security fails open**. Forget the decorator on a webhook and it breaks loudly; forget it the
other way and a route is silently unprotected. `@UseGuards(SessionGuard)` fails closed, and `@Session()`
throws if the guard was left off.

**A correction made mid-step.** The controller initially carried its own copy of the redirect validator,
on a "defence in depth" argument. That argument loses to the evidence: duplicating the GSM-7 label
sanitiser in step 89 produced a copy missing a fix the original already had. `safeRedirect` is now
exported and called from both places — the callback still re-validates `next` on the way out, because it
round-tripped through a user-controlled URL, but through the one implementation.

**What the 9 HTTP tests prove**, against real Nest + Express + Postgres: a protected route rejects with
no cookie and with a junk cookie; the 401 never says *why*; the full magic-link flow sets a
`HttpOnly; SameSite=Lax` cookie that `/auth/me` and a protected route both accept; a replayed link lands
on `/auth/expired` and sets **no** cookie; `next=//evil.example` cannot escape the site; logout
invalidates the cookie; and `@Session()` without the guard returns 500 rather than a tenant-less 200.

---

## Step 98 — the link reaches the owner

`notifications/templates.ts` · `jobs/processors/notify-owner.processor.ts` · `jobs/jobs.module.ts`

D6 delivered. Until now the lead SMS had been arriving with nothing to tap.

```
New lead: End of lease clean
Sarah 0412 345 750
Southbank, 2 bed 2 bath, 1 carpeted
Wants: next Tuesday
http://localhost:3000/auth/callback?token=im-DljO8...&next=%2Fleads%2Fcmshbztxi
```

**The link is last and on its own line.** An SMS client only auto-links a URL whose end it can find;
anything after it on the same line risks being swallowed. A lead text whose link does not tap is a lead
text that does not work.

**Minting never throws.**

```ts
private async magicLinkFor(businessId, leadId): Promise<string | null> {
  try { /* find the oldest user, mint */ }
  catch { return null; }   // the lead still sends
}
```

A missing user, a database hiccup or a misconfiguration degrades the message rather than failing the job.
The name, number and job details are what win the work — a text without a link is worth far more than no
text, and a job retrying forever on a business with no user row is worse than both.

**Minted fresh every time, overwriting the last.** The owner's most recent lead text always works and
older ones stop. For a credential that lives in a message history indefinitely, that is the right trade.

**The segment budget is now exactly full.** A worst-case lead with a link is **413 characters, 3 of 3
segments**. The module-load assertion in `templates.ts` was extended to include a realistic link, because
leaving the single biggest contributor out of the worst case would have made the budget a fiction. A
typical lead is 2 segments. The link alone is 138 characters.

**What the suite proves.** The SMS carries a link; it is on its own line; it points at *this* lead; the
token in it **logs the owner in**, resolves to the right user and business, and works exactly once.

---

## Known gaps

These are stated in the code as well, not only here.

| Gap | Impact | Where |
| --- | --- | --- |
| `POST /auth/request-link` has **no rate limit** | unauthenticated, writes to `users` on every call. Not an enumeration oracle — the response is identical either way — but it needs a per-address throttle before facing the internet | `auth.controller.ts` |
| No email transport | `request-link` mints and logs at debug rather than sending. The SMS path is the real one, so this does not block a pilot | `auth.controller.ts` |
| Owner SMS budget is exactly full | any new field on the owner template pushes a worst-case lead to four segments. The assertion catches it; the fix at that point is a short `/l/<token>` route (≈90 characters back), not raising `MAX_OWNER_SEGMENTS` | `templates.ts` |
| Index on a nullable column | `magic_link_token_hash` is null for almost every row. Fine at pilot scale; a partial index is the right shape later, and Prisma cannot express one | `schema.prisma` |
| One user per business assumed | the notifier picks the oldest user. Every pilot business has one; per-user routing is additive when staff invitations land | `notify-owner.processor.ts` |

## Two things that still gate everything, and neither is code

1. **The carrier forwarding test.** ~A$15, three SIMs, an afternoon. If Telstra/Optus/Vodafone do not
   preserve the original caller's number on a forwarded leg, there is nobody to text and the architecture
   changes. Everything built so far assumes it works.
2. **A real model API key.** Extraction has never run against a real model — every conversation test uses
   `FakeLlmProvider`. An hour would tell you whether the prompt actually pulls a Melbourne suburb out of
   a real text message.
