# Password-protected interactive API documentation at /docs

**Date:** 2026-08-14

## What changed

The API now documents itself. `/docs` serves a full OpenAPI 3.0 reference in
Swagger UI, covering **all 99 endpoints** under `/api/v1` plus `/api/health` —
every operation with a description, every parameter and body field with a type,
constraint, and a realistic example value, and every documented error with the
condition that produces it.

It exists so that someone integrating against this API — a mobile developer, a
partner, a new backend hire — can answer "what does this endpoint take and what
comes back" without reading the controller.

Access is gated behind a password (`SWAGGER_PASSWORD`), and the page executes
real requests against whatever database the deployment serving it is configured
with.

## Coverage

99 operations across 14 tag groups, verified against the router source with no
gap in either direction (nothing undocumented, nothing documented that does not
exist):

| Group | Ops | Group | Ops |
|---|---|---|---|
| Authentication | 17 | Community | 16 |
| Catalogue | 6 | People & Following | 10 |
| Discovery | 3 | Account & Settings | 3 |
| Onboarding & Recommendations | 7 | Notifications | 6 |
| Library | 7 | Shop | 6 |
| Subscription | 7 | Orders & Payments | 3 |
| Referrals | 6 | Service | 1 |

Deliberately **out of scope**: the admin surfaces (`/admin/queues`,
`/admin/gardners/dropship`, `/admin/referrals`), the Stripe webhook, and the
`/r/` referral redirects. None is called by an integrator, and the admin
endpoints are bearer-token operator tools whose shape is not a contract with
anyone outside the team.

## The password gate

`SWAGGER_PASSWORD` is **optional in the schema, and that is the security
control** — when it is unset the docs router is never mounted and `/docs` 404s
along with every other unknown path. A deployment that has not deliberately
chosen a password does not publish a browsable, executable map of the whole API.
The minimum length is 12.

The gate is a login form plus a signed session cookie rather than HTTP Basic.
Basic has no logout, browsers cache it aggressively, and it cannot carry an
expiry — which matters when the page behind it can issue real writes against
production. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/docs`, `Secure` in
production only (so the docs still work over plain HTTP locally), and expires
after `SWAGGER_SESSION_TTL_HOURS` (default 8, max 720).

The session JWT is signed with a key derived from `SWAGGER_PASSWORD` itself, so
**rotating the password invalidates every outstanding session** with no extra
bookkeeping. Password comparison is constant-time, with both sides hashed to a
fixed 32 bytes first so the comparison cannot leak the length. Login attempts
are rate limited to 10/hour — a single shared password with no account behind
it is exactly the thing worth brute-forcing.

## Pointing at the live database

The spec is built **per request**, not once at boot, so `servers[0].url` is
derived from the host the request arrived on. That is what makes "Try it out"
hit *this* deployment — and therefore this deployment's `DATABASE_URL` — rather
than a URL baked in at build time that may belong to a different environment.
Getting that wrong is how someone writes test data into production while reading
a staging docs page.

The page says so plainly rather than leaving it to be discovered. The
description names the environment and the actual database it is connected to
(host and database name, parsed out of `DATABASE_URL` with the credentials
stripped), and states that there is no mock layer: a signup creates an account,
a checkout creates an order, a delete deletes. `NODE_ENV=production` gets a
louder warning. It also reports whether `GATING_ENABLED` is on, since that
decides whether the 402s documented throughout actually fire.

## Structure

The spec lives in `src/docs/openapi/`, as typed modules assembled at request
time — not as JSDoc annotations on the route handlers, which would have added
~2,000 lines of comment to the router files.

```
src/docs/openapi/
  index.ts          assembles the document; resolves servers[] and the DB blurb
  components.ts     security schemes, reusable error responses, shared schemas
  helpers.ts        builders (ref, json, body, param, …) that kill the boilerplate
  paths/
    auth.ts catalogue.ts onboarding.ts library.ts social.ts
    account.ts commerce.ts billing.ts referrals.ts
```

Shared shapes (`BookSummary`, `Post`, `Cart`, `Order`, `Subscription`, the two
error bodies, …) are defined once in `components.ts` and `$ref`'d everywhere, so
they cannot drift between endpoints and Swagger UI renders a model expander for
each. The `helpers.ts` builders exist because a longhand OpenAPI document is
~80% repeated boilerplate, and hand-repeating it is how one endpoint documents a
401 while the next silently forgets to.

## Conventions the docs state explicitly

Things that were true but only discoverable by reading source, now written down
at the top of the page:

- Money is always an **integer in minor units** — `totalMinor: 3497` is $34.97.
- There are **two different error bodies**: `error` is a *string* for anything
  the server decided, and an *object* of `field → [messages]` for anything Zod
  rejected. A client that assumes a string renders `[object Object]` on the
  first bad form submission.
- **402, not 403, means "needs Plus"** — separated so a client can tell
  "subscribe to do this" from "this is not yours" without parsing prose.
- **404 often means "not yours"**; owner-scoped endpoints return 404 rather than
  403 so ids cannot be probed.
- The `X-New-Access-Token` header silently refreshes a session — real clients
  should read it rather than waiting for a 401.
- The **"retain, read-only"** gating rule: create and edit need Plus; read,
  delete and unlike never do.

Per-endpoint rate limits are documented on each operation rather than only in
the middleware.

## Other decisions

- **CSP is relaxed on the docs router only.** Swagger UI needs inline styles and
  scripts, which the app-wide `helmet` default forbids. Loosening it globally to
  accommodate one page would be the wrong trade, so the relaxation is scoped.
- **The page is left on the stock Swagger theme**, with `color-scheme: only
  light` as the single style rule beyond hiding the topbar. That rule is not
  cosmetic: Swagger UI ships no dark theme, so Chrome's "Auto Dark Mode for Web
  Contents" re-tints the page itself and does it unevenly — light background,
  inverted prose, muddy contrast. Declaring the page light opts out. An earlier
  pass tinted the page in Kinkané's colours; that was dropped, because the
  method colours (blue GET, green POST, red DELETE) are how anyone reads this
  page at a glance and are not ours to reinterpret.
- **Cookie parsing is done by hand** (~10 lines) rather than adding
  `cookie-parser`; the app uses no other cookies.
- The router sets `X-Robots-Tag: noindex, nofollow` and `Cache-Control:
  no-store` on everything it serves.
- Mounted outside the `/api` rate limiter — a docs page pulls dozens of static
  assets and would exhaust an API budget by itself.

## How it was verified

Ran locally against the real development database:

- **Coverage** — extracted every `router.<verb>()` registration from the route
  files and diffed it against the operations in the generated spec. Zero
  missing, zero extra (99/99).
- **The gate** — `/docs` and `/docs/openapi.json` both return 401 without a
  session (HTML form for a browser, JSON for anything else); a wrong password
  returns 401; the correct password sets the cookie and redirects; the spec then
  returns 200; after logout it returns 401 again.
- **Disabled by default** — with `SWAGGER_PASSWORD` commented out, the server
  logs "API documentation is disabled", `/docs` 404s, and the rest of the API is
  unaffected.
- **The database claim** — confirmed `servers[0].url` resolves to the running
  deployment, then checked that `GET /api/v1/genres` through that URL returns
  exactly what a direct `postgres` query against `DATABASE_URL` returns
  (2,185 rows, same first row).
- Swagger UI renders and loads the spec: all 14 tag groups present, no console
  errors, every asset 200.

## Configuration

```bash
# Required to enable the docs at all. Unset = /docs 404s. Min 12 chars.
SWAGGER_PASSWORD=$(openssl rand -base64 24)

# Optional. How long a sign-in lasts. Default 8, max 720.
SWAGGER_SESSION_TTL_HOURS=8
```

Both are documented in `.env.example`. Note that `render.yaml` does **not**
declare `SWAGGER_PASSWORD` — it has to be set deliberately in the Render
dashboard, which is the intended friction.
