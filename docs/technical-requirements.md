# Kinkané Server — Technical Requirements Document

**Service:** `kinkane-server`
**Status:** Living document — describes the system as built
**Last reviewed:** 2026-09-08

This document is the engineering reference for what the Kinkané API does, what it must
guarantee, and why it is built the way it is. It complements rather than repeats:

- [`README.md`](../README.md) — how to run, configure and deploy the service
- `/docs` (OpenAPI) — the executable, per-endpoint request and response contract
- `src/routes/*.routes.ts` — the contract and reasoning for each individual endpoint
- [`changelog/`](../changelog/) — the write-up for each notable change as it landed

Where this document and the code disagree, the code is right and this document is a bug.

---

## Table of contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [System context](#2-system-context)
3. [Architecture](#3-architecture)
4. [Functional requirements](#4-functional-requirements)
5. [Data model](#5-data-model)
6. [External integrations](#6-external-integrations)
7. [Non-functional requirements](#7-non-functional-requirements)
8. [Operations](#8-operations)
9. [Testing strategy](#9-testing-strategy)
10. [Known limitations and open items](#10-known-limitations-and-open-items)
11. [Glossary](#11-glossary)

---

## 1. Purpose and scope

### 1.1 What this service is

Kinkané is a book discovery and reading platform with a shop attached. `kinkane-server` is
the single HTTP API behind every client: the mobile app, the storefront, and the staffed
admin console. It owns identity, personalisation, social features, commerce, subscriptions,
the referral competition, and the operational surfaces used to run all of it.

### 1.2 What it is not

- **Not the catalogue ingester.** Book, contributor, price and supplier-feed data is produced
  by `onix_ingester` from ONIX 3.1 XML and Gardners feeds. This service reads those tables
  and never writes them.
- **Not the client.** No HTML is rendered for customers. The only server-rendered surfaces
  are the OpenAPI docs page and the Bull Board queue dashboard.
- **Not a payment processor.** Stripe holds card data; this service never sees a card number.
- **Not the warehouse.** Physical fulfilment is Gardners' dropship service, reached over SFTP.

### 1.3 Primary users

| User | What they need from this service |
|------|----------------------------------|
| Reader (mobile app) | Sign in, take the quiz, get recommendations, keep a bookshelf, follow people, post, buy books, refer friends |
| Shopper (storefront) | Browse the catalogue, price a basket for their country, check out, track an order |
| Guest | Take the quiz and buy a book without an account, and claim that order later |
| Staff (admin console) | Watch orders and revenue, handle reports and blacklists, export customers, edit storefront banners |
| Operator (deployment) | Retry a failed fulfilment job, correct a referral, submit a dropship order by hand |

---

## 2. System context

```
                 ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
                 │  Mobile app  │   │  Storefront  │   │ Admin console  │
                 └──────┬───────┘   └──────┬───────┘   └───────┬────────┘
                        │  HTTPS / JSON    │                   │
                        └────────┬─────────┴───────────────────┘
                                 ▼
                      ┌─────────────────────┐
                      │   kinkane-server    │──── Firebase Admin  (social sign-in, FCM push)
                      │  Express + Drizzle  │──── Google Gemini   (embeddings, explanations)
                      │  crons + BullMQ     │──── Resend          (email)
                      └────┬───────────┬────┘──── Stripe          (subscriptions, orders)
                           │           │     ──── Gardners SFTP   (dropship fulfilment)
                           │           │     ──── MaxMind         (country resolution)
                           ▼           ▼
                    ┌────────────┐  ┌───────┐
                    │ PostgreSQL │  │ Redis │
                    │  pgvector  │  │ cache │
                    │  pg_trgm   │  │ queues│
                    └─────▲──────┘  └───────┘
                          │
                   ┌──────┴───────┐
                   │ onix_ingester│  writes the catalogue this service reads
                   └──────────────┘
```

### 2.1 Trust boundaries

| Boundary | Enforced by |
|----------|-------------|
| Anonymous internet → API | Rate limits keyed on the real client IP (`trust proxy = 2`), Helmet, 50 kB body cap, CORS pinned to `APP_URL` outside development |
| Customer → their own data | `requireAuth`; every service query is scoped by `userId` from the verified token, never from the request body |
| Customer → paid features | `requirePlus` → 402 `PLUS_REQUIRED` |
| Anyone → admin console | `requireAdmin`, a per-person session signed with a separate secret |
| Anyone → machine surfaces | Static `ADMIN_TOKEN` bearer |
| Stripe → webhook | Signature over the raw request body |
| Client → its own request id | Inbound `X-Request-Id` is prefixed before use so it cannot collide with or impersonate a server-issued id |

The customer and admin JWT secrets are deliberately distinct. A customer access token must
never authenticate against the console, and rotating the admin secret must not sign every
customer out.

---

## 3. Architecture

### 3.1 Layering

```
routes/        path + guards + limiter + the JSDoc contract     (no logic)
controllers/   parse and validate input, call a service, shape the response
services/      all business logic, all database access
lib/           shared primitives with no domain knowledge
db/schema/     Drizzle tables, with the reasoning next to the columns
```

**Requirement:** a decision belongs in a service. A route file that branches on business
state, or a controller that queries the database, is a defect regardless of whether it works.
This is what keeps the logic testable without standing up Express.

### 3.2 Middleware order

Order is load-bearing and must not be rearranged casually:

1. `trust proxy = 2` — two proxy hops (Cloudflare, then Render's load balancer). Wrong here
   means every anonymous user behind one Cloudflare PoP shares a rate-limit bucket.
2. `helmet`, `cors`
3. **Stripe webhook** — mounted *before* `express.json`, because signature verification needs
   the unparsed bytes. It has its own raw parser and no rate limiter.
4. `express.json` / `urlencoded`, capped at 50 kB
5. `requestLogger` — one line per request plus a request id threaded through every downstream
   log line. Deliberately after body parsing and before every route.
6. Admin mounts, referral redirects, `/docs`, `/api`
7. 404, then the global error handler

### 3.3 Error contract

`src/app.ts` holds one rule that every service must be written against:

| Thrown error | What the client receives |
|--------------|-------------------------|
| Tagged with `statusCode < 500` | `{ error: message, code?, ...details }` — the message surfaces |
| Tagged with `statusCode >= 500` **and** a `code` | The message surfaces, and it is logged at `warn` |
| Tagged `5xx` with no `code` | Generic `500 Internal server error` |
| Untagged | Generic `500 Internal server error` |
| `SyntaxError` from body parsing | `400 Request body contains invalid JSON` |

The `code` requirement on 5xx is the whole point: it separates a curated failure like
`PARCEL_TOO_HEAVY` from a stray re-thrown upstream error whose text would leak request ids
and endpoint fragments to a client.

**Requirement:** any 5xx a client is expected to act on must carry a stable `code`. Any error
whose message a client should never see must not be tagged.

### 3.4 Versioning

`/api/v1` is the API. `/api/v2` exists for exactly one route, `GET /books`, which accepts a
`type` parameter that v1 rejects.

**Requirement:** do not mirror a route into v2 unless its behaviour actually differs.
Identical duplicates create pairs to keep in step, and the first divergence between them
would be an accident rather than a decision. The v2 router shares the v1 limiter *instance*,
so moving a call from v1 to v2 does not hand a client a second budget.

---

## 4. Functional requirements

Requirements are numbered by area so they can be referenced from tickets and commit bodies.

### 4.1 Identity and sessions (FR-A)

| ID | Requirement |
|----|-------------|
| FR-A1 | An account can be created with email + password, or with a Firebase ID token from Google, Facebook or Apple. Both paths return the same token pair, and `requireAuth` cannot tell them apart afterwards. |
| FR-A2 | Signup requires a `guestSessionId`. A person must complete the quiz before an account exists, so no account starts with no preferences. |
| FR-A3 | Access tokens are JWTs signed with `JWT_ACCESS_SECRET`, default lifetime 15 minutes. |
| FR-A4 | Refresh tokens are opaque, stored only as a SHA-256 hash, and **rotate on every refresh** — the presented token is deleted and a new pair issued. |
| FR-A5 | Logout deletes the refresh token server-side. A logged-out token must not work again even if it was intercepted. |
| FR-A6 | One social account cannot be linked to two users: `(provider, provider_uid)` is unique. |
| FR-A7 | Password reset uses a single-use hashed token with a 1-hour lifetime; requesting a new one invalidates the previous. |
| FR-A8 | Changing an email address requires an OTP sent to the new address, and notifies the old address with a cancellation link. |
| FR-A9 | Account deletion cascades every owned row and sends a confirmation email. |
| FR-A10 | The last-seen timestamp must not be written on every token refresh — a background refresh is not activity, and treating it as such inflated the console's active-customer count. |

### 4.2 Onboarding and guest sessions (FR-B)

| ID | Requirement |
|----|-------------|
| FR-B1 | The entire quiz works without an account. A guest session holds name, feelings, liked books, genres and dislikes. |
| FR-B2 | The guest session id returned to the client *is* the credential for that session. |
| FR-B3 | A guest session expires after `GUEST_SESSION_TTL_HOURS` (default 72) and is deleted by cron. |
| FR-B4 | On registration, preferences, reading list and interaction signals migrate to the new account in the background; token issuance must not wait on the migration. |
| FR-B5 | A referral code can be attached to a guest session before signup, so attribution survives the quiz. |
| FR-B6 | At most 5 books can be chosen from the recommendation results. |

### 4.3 Catalogue and search (FR-C)

| ID | Requirement |
|----|-------------|
| FR-C1 | Catalogue tables are read-only to this service. No migration generated here may alter them. |
| FR-C2 | Search resolves in order: ISBN lookup → full-text search on the trigger-maintained `search_vector` → `pg_trgm` trigram fallback for typos. |
| FR-C3 | `q` intersects with every other filter rather than replacing them. |
| FR-C4 | A–Z title sorting puts placeholder titles last, and titles starting with a number or symbol below the letters. |
| FR-C5 | Editions of the same work link to each other even when the publisher differs or the author's name is stored surname-first. |
| FR-C6 | Book formats are presented in plain language, not ONIX product-form codes. |
| FR-C7 | Cold catalogue pages must not pay for full-table counts; count probes are bounded. |
| FR-C8 | `GET /api/v2/books` accepts `type`; `GET /api/v1/books` rejects it. |

> **Collation constraint.** The database's ctype is `C`, so POSIX regex character classes are
> ASCII-only. Any query matching accented text must use `COLLATE "und-x-icu"`.

### 4.4 Recommendations (FR-D)

| ID | Requirement |
|----|-------------|
| FR-D1 | Preferences are turned into a natural-language paragraph, embedded with `GEMINI_EMBEDDING_MODEL`, and ranked by pgvector cosine distance against stored book embeddings. |
| FR-D2 | `GEMINI_EMBEDDING_MODEL` must match the model `onix_ingester` used to embed books. Mismatched models make every score meaningless. |
| FR-D3 | Each result carries an explanation of at most 120 characters, generated in batch by `GEMINI_FLASH_MODEL` with a configured fallback model. |
| FR-D4 | Results are cached for 48 hours against a SHA-256 hash of the preferences. `displayName` is excluded from that hash. |
| FR-D5 | Because the cache is shared across people with identical answers, a cached explanation stores a `{{name}}` placeholder and the real name is substituted at read time. |
| FR-D6 | Recommendations are filtered to books the shop can actually sell. Recommending an unbuyable title is worse than returning one fewer book. |
| FR-D7 | The HNSW index must be queried such that post-filtering does not starve the result set — filters are applied to what the scan returns, so `ef_search` and iterative scan settings must be sized for the filters in play. Regression-tested in `vector-recall.test.ts`. |

### 4.5 Library and personalisation (FR-E)

| ID | Requirement |
|----|-------------|
| FR-E1 | A book appears at most once per reading list: `(user_id, book_id)` is unique. |
| FR-E2 | Reading-list statuses are `want_to_read`, `reading`, `read`; source records how the book arrived. |
| FR-E3 | A note on a shelved book is private unless explicitly marked public. |
| FR-E4 | Shelf visibility is `public`, `friends` or `private`, defaulting to `private`. |
| FR-E5 | Interaction signals (`view`, `purchase`, `high_rating`, `wishlist`, `chosen_from_recommendation`) are weighted, and old rows are trimmed by cron. |
| FR-E6 | Dislikes and exclusions are honoured on every subsequent recommendation. |
| FR-E7 | Preference history is retained for 2 years, except each user's most recent row, which is always kept. |

### 4.6 Community (FR-F)

| ID | Requirement |
|----|-------------|
| FR-F1 | Posts are attached to a book and a reading status (`reading`, `read`). |
| FR-F2 | Following is request-based: a request is `pending`, `accepted` or `declined`, and both directions of a user's requests are listable. |
| FR-F3 | Reading and browsing the feed is open to every signed-up user; **creating** a post or comment, and liking, require Plus. |
| FR-F4 | Any user can report a post or a user. A report survives the deletion of the post it was filed against — `post_id` is nulled rather than cascading the report away. |
| FR-F5 | A blacklisted customer cannot post, comment or like. Enforcement is tested in `blacklist-enforcement.test.ts`. |
| FR-F6 | A follow-request email is not marketing and must keep sending after an unsubscribe. |

### 4.7 Commerce (FR-G)

| ID | Requirement |
|----|-------------|
| FR-G1 | Nothing in the shop is gated behind Plus. Buying is open to every signed-up user. |
| FR-G2 | The destination **country** is collected by this API before pricing. Stripe's address collection is then locked to that country, so the address a buyer types can vary in every way except the one the order was priced on. |
| FR-G3 | All pricing — currency resolution, FX from GBP with a buffer, shipping bands, VAT, first-order discount — is a pure function of amount, country and configuration. No database, no Redis, no request object. |
| FR-G4 | Pricing rules are operator-editable through environment configuration and must not require a deploy to change. |
| FR-G5 | Money is always an integer in a currency's **minor unit** — never a float. `0.1 + 0.2` is the oldest bug in commerce. |
| FR-G5a | The minor unit is not always 1/100. JPY, KRW and roughly twenty others have none, and Stripe rejects an amount that assumes one. Nothing may multiply by a hardcoded 100. |
| FR-G5b | Conversion rounds **up**, against the customer's favour. That is a pricing decision, not a numerical one, and it is concentrated in `lib/money.ts` so it can be argued with in one place. |
| FR-G6 | A basket too heavy or too large for one parcel must fail with a specific, client-readable code, never a bare 500. |
| FR-G7 | Guests can check out. An order is retrievable with a short tracking code plus the buyer's email, and can be claimed onto an account later. |
| FR-G8 | The order confirmation email goes to the address the buyer actually typed, and must never print a guest's long access code. |
| FR-G9 | Fulfilment runs on a queue, never inside the Stripe webhook. An SFTP round trip inside a webhook would time out, Stripe would redeliver, and payment success would depend on a supplier's FTP being up. |
| FR-G10 | Gardners' EDI address fields are fixed-width `varchar(35)` (postcode 8) read by a legacy parser. Over-long values are truncated before submission, never rejected at the far end. |
| FR-G11 | Order acknowledgements (`.ACK`) and dispatches (`.HDD`) are polled on a shared tick but with independent failure handling — an SFTP hiccup in one directory says nothing about the other. Both polls are idempotent. |
| FR-G12 | Bestsellers are computed from this platform's own `order_items`, counting copies and never revenue (which would rank differently per currency). When nothing sold in the window the response falls back to trending and **says so** in `source`. |
| FR-G13 | Cart limits (`CART_MAX_ITEMS`, `CART_MAX_QUANTITY_PER_LINE`) are enforced server-side. |
| FR-G14 | A book the shop cannot sell must not be addable to a cart or recommendable. |

**Order lifecycle**

```
pending_payment ──▶ paid ──▶ submitted_to_supplier ──▶ acknowledged ──▶ dispatched ──▶ delivered
      │                                     │
      ├─▶ payment_failed                    └─▶ supplier_rejected
      ├─▶ expired
      └─▶ cancelled                                        refunded  (recorded manually)
```

### 4.8 Subscriptions (FR-H)

| ID | Requirement |
|----|-------------|
| FR-H1 | Every new account gets a 90-day Kinkané Plus trial, created synchronously at signup. |
| FR-H2 | The trial is ours, not Stripe's. There is no Stripe trial object, and a trialing user has nothing to cancel. |
| FR-H3 | Effective tier is computed at read time; an expired trial reads as `free` with no write required. An hourly cron flips the stored row as housekeeping, re-checking its guards inside the `UPDATE` so it cannot double-flip or downgrade a payer. |
| FR-H4 | Entitlement is cached in Redis for 60 seconds and invalidated explicitly on every write that could change it, so someone who just paid is not told to pay again. |
| FR-H5 | `past_due` remains entitled. Stripe is retrying the card, and cutting access on the first failure costs more than it saves. |
| FR-H6 | The gate returns **402** with `code: 'PLUS_REQUIRED'`, never 403 — the client must distinguish "subscribe" from "not yours" without parsing prose. |
| FR-H7 | The gate **fails open**. If entitlement cannot be read, the database or Redis is in trouble and locking out paying subscribers makes it worse. |
| FR-H8 | `GATING_ENABLED` turns gating on and off without a deploy. |
| FR-H9 | Cancellation takes effect at the end of the paid period, never immediately, and is idempotent. |
| FR-H10 | A Stripe subscription *schedule* must be released before `cancel_at_period_end` can be set — otherwise a founding member on a scheduled price cannot cancel at all. |
| FR-H11 | `POST /change` with `plan: 'free'` is the same action as cancel and also requires a reason, so every cancellation reaches the reasons ledger regardless of which button was pressed. |
| FR-H12 | A plan change is confirmed with the account password, or for social accounts a Firebase ID token whose `auth_time` is within 5 minutes. |
| FR-H13 | Founding-member pricing is available until `FOUNDING_OFFER_ENDS_AT` and is preserved across a reactivate — which is why reactivate exists rather than telling people to check out again. |
| FR-H14 | Stripe webhook events are recorded in `stripe_webhook_events` for idempotency; a redelivered event must not double-apply. |
| FR-H15 | Without Stripe configuration the billing endpoints return **503**, not a half-working flow. |

### 4.9 Referral competition (FR-I)

| ID | Requirement |
|----|-------------|
| FR-I1 | Referral is open to every signed-up user — `requireAuth` only, never `requirePlus`. |
| FR-I2 | Attribution (*who referred whom*) and scoring (*what that is worth*) are separate services. Attribution is a durable fact; scoring is a rule that can change and be recomputed from it. |
| FR-I3 | Scoring must never fail a signup. A scoring error is logged and the referral still records. |
| FR-I4 | Awards: same country 1, same continent 10, cross continent 20, indirect same continent 5, indirect cross continent 10, full circuit 30. |
| FR-I5 | Points reach at most one person beyond the direct referrer. This bound stops an early user's score compounding forever off a tree they stopped contributing to. Circuits are the deliberate exception. |
| FR-I6 | Chains stop being recorded as connected beyond depth 20. |
| FR-I7 | Country is resolved once, at signup, and frozen on the user row. Someone travelling must not change continent mid-competition. |
| FR-I8 | Country resolution reports *how* it knows (`header`, `maxmind`, `admin`, `unknown`) and returns `unknown` rather than guessing. |
| FR-I9 | An admin can correct a country and void a referral; both are audited. |
| FR-I10 | Referral links live at `/r/:code/:slug`, root-mounted — they are links people send over WhatsApp, and are registered as the universal/app link. |
| FR-I11 | Clicks and shares are recorded for analytics without requiring the visitor to be signed in. |

### 4.10 Notifications (FR-J)

| ID | Requirement |
|----|-------------|
| FR-J1 | Email is always enqueued, never sent from a request path. |
| FR-J2 | Job priorities are fixed per type so a password reset never queues behind a newsletter. |
| FR-J3 | One-click unsubscribe clears exactly `marketingEmails`, `newBookSuggestions` and `rateReviewReminders`, and nothing else. Follow requests, trial-ending, billing and security email keep sending. |
| FR-J4 | Push fans out to every device token a user has registered; tokens FCM reports as unregistered or invalid are deleted as they are discovered. |
| FR-J5 | A missing Firebase credential skips the push with a warning; it must not fail the action that triggered it. |
| FR-J6 | In-app notifications are durable rows. Follow requests are merged into the same feed as post likes and comments at read time, so the client sees one ordered list rather than two. |

### 4.11 Admin (FR-K)

| ID | Requirement |
|----|-------------|
| FR-K1 | Any endpoint that can blacklist a customer or export the customer list must sit behind a **per-person** session, never the static deployment token. |
| FR-K2 | The first admin can be created from `ADMIN_BOOTSTRAP_*` at startup, and the bootstrap does nothing once the table is non-empty. |
| FR-K3 | A customer counts as active only if genuinely seen in the last year — a shop browser who never signed in is not a customer. |
| FR-K4 | The console exposes the shipping-margin report: what shipping actually costs versus what was charged. |
| FR-K5 | Storefront banners are edited in the console; the public endpoint returns only *enabled* banners, so a client cannot cache a banner that was switched off. |
| FR-K6 | The queue dashboard must include the fulfilment queue: a failed job there is a paid order that never reached the supplier. |

---

## 5. Data model

PostgreSQL 14+, with `pgvector` (recommendation embeddings) and `pg_trgm` (typo-tolerant
search). Around 60 tables across 34 files in `src/db/schema/`. Column-level reasoning lives
in those files; this section covers the entities and how they relate.

### 5.1 Ownership

| Owner | Tables |
|-------|--------|
| `kinkane-server` | Everything in 5.2 – 5.9 |
| `onix_ingester` | `books`, `book_contributors`, `book_subjects`, `book_genres`, `book_prices`, `book_excerpts`, `book_promotions`, `genres`, all `gardners_*` feed tables, `ingestion_jobs`, `ingestion_chunks` |

The ingester-owned tables are declared here as read-only Drizzle representations so they can
be joined against. **A migration generated in this repository must never alter them.**

### 5.2 Accounts

```
users ──1:N── refresh_tokens
  │  ──1:N── user_providers          (provider, provider_uid) unique
  │  ──1:N── password_reset_tokens   hashed, single use, 1 hour
  │  ──1:N── email_verification_tokens
  │  ──1:N── email_change_requests
```

`users` holds the freeform name, lowercase email, optional password hash (NULL for
social-only accounts), photo URL, verification flag, `shelf_visibility`, the frozen
`country_code` used by the referral competition, and the last-seen timestamp behind FR-A10.
Every child table cascades on delete.

### 5.3 Onboarding and personalisation

```
guest_sessions ──(migrated on signup)──▶ user_preferences
                                         user_books
                                         user_interactions
users ──1:N── user_disliked_books
      ──1:N── user_preference_history   2-year retention, most recent row always kept
```

`guest_sessions` carries `display_name`, `feelings`, `book_ids`, `genres`, `dislikes`,
`chosen_book_ids` and `recommendation_hash`, with a hard `expires_at`. `user_books` is unique
on `(user_id, book_id)`.

### 5.4 Recommendations

`recommendation_cache` — keyed on `input_hash` (SHA-256 of preferences, excluding the display
name), holding `[{ bookId, rank, explanation }]` with a 48-hour `expires_at`. Explanations
store `{{name}}` rather than a real name, because the row is shared between everyone whose
answers hash the same way.

`recommendation_email_log` — what was sent to whom and when, which is what enforces the
5-day cadence on the daily recommendation email.

### 5.5 Community

```
posts ──1:N── comments
  │      │
  ├──1:N─┴── post_likes / comment_likes
users ──N:N── users   via follow_requests (pending | accepted | declined)
user_reports          post_id nullable so a report outlives the post
```

### 5.6 Commerce

```
carts ──1:N── cart_items          status: active | converted | abandoned
orders ──1:N── order_items
  │  ──1:N── payments             status: pending | succeeded | failed | expired | cancelled
  └──▶ gardners_dropship_orders ──1:N── gardners_dropship_order_lines
                                 ──1:N── gardners_dropship_dispatches
saved_books      the purchase wishlist, distinct from the reading list
shipping_rates   the rate card, seeded and regenerable
```

`orders` records both sides of the money: the GBP figures the order was costed in
(`*_gbp_pence`) and the presentment figures the buyer was actually charged (`*_minor` plus
`presentment_currency`), with the `fx_rate` and `fx_captured_at` that connect them. It also
carries the reference, the short tracking code, the hashed guest access token, the tax rate
and its source, the shipping rule, service code and measured weight, the captured shipping
address, the Stripe session and payment intent ids, the discount and its reason, and the
carrier tracking details once dispatched.
Dispatch rows are arbitrated by a unique constraint so a repeated `.HDD` poll cannot
duplicate a shipment.

### 5.7 Subscriptions

```
user_subscriptions          current state only, one row per user
subscription_events         started | extended | expired | converted | cancelled | renewed
                            payment_failed | resumed | plan_changed | refunded
subscription_state_history  the audit trail of every transition
stripe_webhook_events       idempotency ledger — a redelivered event applies once
```

`user_subscriptions` holds `tier` (`free | plus`), `status`
(`active | trialing | expired | cancelled | past_due | incomplete`), `plan`
(`monthly | annual`), `trial_ends_at`, the Stripe customer and subscription ids, and the
cancellation reason. `trial_ends_at` is kept as a historical fact even after the trial ends.

### 5.8 Referrals

```
referral_codes ──1:N── referral_clicks
              ──1:N── referral_invites
referrals      (referrer, referred) with status active | voided
referral_points  kind: same_country | same_continent | cross_continent
                       indirect_same_continent | indirect_cross_continent | full_circuit
                 state: recorded per award so it can be recomputed
countries        code → name, continent
```

### 5.9 Notifications and admin

```
notifications, notification_preferences, device_tokens
admins, admin_notifications, announcement_banners, contact_messages
```

### 5.10 Migrations

Drizzle Kit, SQL files in `drizzle/`, applied by `npm run db:migrate`, which first installs
the extensions and builds concurrent indexes so it works against a fresh database. Migrations
are applied by Render's pre-deploy command on every deploy and must therefore be idempotent
and backward-compatible with the currently running instance.

---

## 6. External integrations

| Service | Used for | Failure mode |
|---------|----------|--------------|
| **PostgreSQL** | Everything durable | Hard dependency — the process is useless without it |
| **Redis** | Rate limits, entitlement and catalogue caches, BullMQ | Rate limiting and queues degrade; entitlement reads fall back to the database with a warning |
| **Firebase Admin** | Social sign-in verification, FCM push | Startup fails if unconfigured (social sign-in would silently reject every Google login while health checks passed). Push sends are skipped with a warning |
| **Google Gemini** | Query embeddings, recommendation explanations | Configured fallback model; failures degrade the recommendation, not the request |
| **Resend** | All outbound email | Absorbed by the queue — 3 attempts with exponential backoff, then a `failed` job an operator can retry |
| **Stripe** | Subscription and order checkout, webhooks | Unconfigured → billing endpoints return 503. Webhook signature failures are rejected outright |
| **Gardners SFTP** | Dropship order submission, `.ACK` and `.HDD` polling | Off the request path entirely — a failed job stays on the fulfilment queue for retry |
| **MaxMind** | Country resolution when no CDN header is present | Returns `unknown`; scoring handles it rather than guessing |
| **Cloudinary** | Image hosting. The server never uploads; `CLOUDINARY_CLOUD_NAME` is used to **validate** that a profile photo URL points at `res.cloudinary.com` under the configured cloud | A rejected URL is a 400, not an outage |

### 6.1 Stripe specifics

- The webhook is mounted **before** `express.json`. Stripe signs the exact bytes it sends, so
  the signature can only be verified against an unparsed body.
- The webhook is unauthenticated by design — the signature *is* the authentication — and sits
  outside the rate limiter, because Stripe's delivery volume is not abuse.
- Webhook state is the source of truth for subscriptions. Checkout responses are optimistic;
  the webhook is what commits.
- Dynamic `shipping_options` are deliberately **not** used. Expressing every shipping and tax
  rule in Stripe's model is the exact thing the environment-driven pricing design exists to
  avoid.

### 6.2 Gardners specifics

Fixed-width EDI over SFTP against a legacy parser. Address fields are `varchar(35)`, postcode
8. The authoritative country/service-code list (`I12d FTP Country List.txt`) is not in the
specification PDF and has to be requested from Gardners, so `gardners-countries.ts` documents
exactly how much of its table is verified — which is very little.

Not implemented, inherited from a dropship module built only to prove the order→ack cycle:
backorder (`BACKORD.TXT`) reconciliation and cancellation (`.CRF`/`.CRA`). A refund is
therefore a manual Stripe action plus a call to Gardners, recorded against the order with the
`refunded` status.

---

## 7. Non-functional requirements

### 7.1 Security

| ID | Requirement |
|----|-------------|
| NFR-S1 | Secrets are read only in `src/config/index.ts`, validated with Zod, and the process refuses to start if any required value is missing or malformed. |
| NFR-S2 | Passwords are bcrypt-hashed. Refresh, reset, verification and guest-access tokens are stored only as SHA-256 hashes. |
| NFR-S3 | JWT secrets are at least 32 characters, and the customer and admin secrets are distinct. |
| NFR-S4 | Every authenticated query is scoped by the `userId` from the verified token. A user id in a request body is never trusted for authorisation. |
| NFR-S5 | Request bodies are capped at 50 kB. |
| NFR-S6 | CORS is pinned to `APP_URL` outside development. |
| NFR-S7 | Helmet sets the standard security headers. |
| NFR-S8 | Rate limits are enforced on every `/api` route, counted in Redis so they hold across instances, keyed on the real client IP. |
| NFR-S9 | Query strings are excluded from the request log — tokens end up in them. |
| NFR-S10 | `lib/log-scrubber.ts` redacts session tokens, passwords and other named secrets from every log line. |
| NFR-S11 | `LOG_REQUEST_PAYLOADS` defaults to off outside development. A body is caller-controlled: the next endpoint to accept a secret under a name nobody added to the scrubber would otherwise write it in the clear into an aggregator whose retention outlives anyone's memory of having enabled this. |
| NFR-S12 | Inbound `X-Request-Id` values are prefixed so they cannot be spoofed. |
| NFR-S13 | A 5xx surfaces its message to a client only when it carries a machine-readable `code` (§3.3). |
| NFR-S14 | `/docs` is mounted only when `SWAGGER_PASSWORD` is set. It executes real requests against the configured database, so a deployment that never chose a password does not publish an executable map of the API — it 404s. |
| NFR-S15 | Card data never reaches this service. Checkout is redirect-based; Stripe holds the instrument. |
| NFR-S16 | The Stripe webhook is verified by signature over the raw body and is the only unauthenticated write endpoint. |
| NFR-S17 | Customer-list export and blacklisting are behind a per-person admin session, never the static token. |

### 7.2 Performance

| ID | Requirement |
|----|-------------|
| NFR-P1 | Entitlement is read on nearly every authenticated request and must not put a database round trip in front of it — hence the 60-second Redis cache with explicit invalidation. |
| NFR-P2 | Recommendation results are cached for 48 hours; an uncached request costs real money at Gemini rates, a cached one costs nothing. |
| NFR-P3 | The bestseller chart is cached for an hour and its windows are dropped nightly at 04:10 so the day's first reader gets a correctly-bounded `7d`. |
| NFR-P4 | Catalogue listing must not pay for full-table counts on a cold page; count probes are bounded (`search-count-probes.test.ts`). |
| NFR-P5 | A heavy basket must not load the shipping rate table twice. |
| NFR-P6 | Vector search must be configured so filters applied after the HNSW scan do not starve the result set (`vector-recall.test.ts`). |
| NFR-P7 | The recommendation email cron processes at most 10 users concurrently, sized to the connection pool and the email queue rather than to wall-clock speed. |
| NFR-P8 | Email sends run at concurrency 5, within Resend's limits. |
| NFR-P9 | Long-running external work — SFTP submission, bulk email — is never on the request path. |

### 7.3 Reliability

| ID | Requirement |
|----|-------------|
| NFR-R1 | Queued jobs retry 3 times with exponential backoff (2s, 4s) and are retained in the `failed` state for inspection and manual retry. |
| NFR-R2 | Shutdown is graceful: stop the crons, stop accepting connections, drain in-flight requests, then finish the active email and fulfilment jobs, then close the queues and Redis. Redis is disconnected **last** so an in-flight request can still reach it. |
| NFR-R3 | Killing the fulfilment worker mid-write must not be possible — a partial `.ORD` file left on Gardners' server is worse than a slow shutdown. |
| NFR-R4 | Stripe webhook processing is idempotent; a redelivered event applies once. |
| NFR-R5 | Cron jobs that could run concurrently across instances are idempotent, with the correctness boundary inside the write (a guarded `UPDATE`, a unique constraint), not in the candidate query. |
| NFR-R6 | Referral scoring failures must not fail a signup. |
| NFR-R7 | A Redis blip must not take the API down: entitlement reads fall back to the database with a warning. |
| NFR-R8 | The Plus gate fails open. |
| NFR-R9 | `GET /api/health` is unversioned and unthrottled so uptime checks are never rate-limited. |
| NFR-R10 | Every configurable integration degrades to a disabled feature, never to a half-working one. |

### 7.4 Observability

| ID | Requirement |
|----|-------------|
| NFR-O1 | Logs are structured JSON on stdout, read through Render's log explorer. There is no separate error-reporting service; Sentry was removed deliberately. |
| NFR-O2 | One line per request: method, path, status, duration, request id. |
| NFR-O3 | A request id is threaded into every downstream log line, so one request's work can be reassembled from an aggregator. |
| NFR-O4 | `LOG_LEVEL` defaults to `debug` in development and `info` elsewhere. |
| NFR-O5 | Queue depth, failures and payloads are visible in Bull Board at `/admin/queues`. |
| NFR-O6 | The admin console dashboard is the operational view of orders and revenue; `npm run shipping:margin` reports charged-versus-actual shipping. |

### 7.5 Maintainability

| ID | Requirement |
|----|-------------|
| NFR-M1 | Comments explain **why**, not what. The non-obvious decisions are recorded next to the code that embodies them. |
| NFR-M2 | The JSDoc above a route is its contract: request shape, response shape, and every error code it can return. |
| NFR-M3 | Commits use Conventional Commits with plain-language descriptions, because `CHANGELOG.md` is generated from them and read by non-engineers. See `CLAUDE.md`. |
| NFR-M4 | Anything beyond a trivial change gets a dated write-up in `changelog/`: what changed, why, the data or API shape, the non-obvious decisions, what was left out of scope, and how it was verified. |
| NFR-M5 | Business rules that can be expressed as pure functions of plain data should be, so they can be tested exhaustively without fixtures. |
| NFR-M6 | Environment configuration is documented in `.env.example` at the point of definition, and that file is kept in step with `config/index.ts`. |

### 7.6 Compliance and privacy

| ID | Requirement |
|----|-------------|
| NFR-C1 | Account deletion removes every owned row by cascade. |
| NFR-C2 | Marketing email carries a one-click unsubscribe; transactional and security email does not, and unsubscribe cannot switch it off (FR-J3). |
| NFR-C3 | VAT is applied per destination from operator-configured rates, with the tax rate and its source recorded on the order. |
| NFR-C4 | Personal data is not written to logs: the scrubber redacts named fields and payload logging is off by default outside development. |
| NFR-C5 | The referral competition's IP-based country resolution is defeatable by a VPN. With no prizes attached, that exposure is accepted deliberately and documented in `docs/referral-system-plan.md`. If prizes are ever attached, this decision must be revisited. |

---

## 8. Operations

### 8.1 Deployment

Single Render web service. Build `npm install && npm run build`, pre-deploy `npm run db:init`,
start `node dist/server.js`, health check `/api/health`. Database and Redis are shared with
`onix_ingester`.

**Scaling constraint.** Crons and BullMQ workers run inside the web process, so every
additional instance runs every cron. The jobs that would be dangerous under that are written
to be idempotent, but that is a property to verify per job before scaling out, not a blanket
guarantee. Moving the schedulers and workers into their own process is the correct fix when
horizontal scaling is needed.

**Proxy configuration.** `trust proxy = 2` reflects Cloudflare in front of Render's load
balancer. If the chain gains or loses a hop, that number changes — and getting it wrong
silently collapses anonymous rate limiting onto shared edge addresses.

`GEO_COUNTRY_HEADER=cf-ipcountry` is safe despite being client-settable: Render's Cloudflare
overwrites any `cf-*` header a client sends (verified 2026-09-02 — a forged `cf-ipcountry: ZZ`
arrived as the true `GH`). That Cloudflare is Render's rather than ours, so it is undocumented
and could disappear; `geo.service` then degrades to a null country rather than trusting it.

### 8.2 Scheduled work

| Job | Schedule (UTC) |
|-----|---------------|
| Guest session cleanup | `0 */6 * * *` |
| Trial expiry | `0 * * * *` |
| Order reconciliation (`.ACK` then `.HDD`) | `*/30 * * * *` |
| Subscription reconciliation against Stripe | `15 3 * * *` |
| Preference history cleanup | `20 3 * * *` |
| Interaction cleanup | `40 3 * * *` |
| Bestseller cache invalidation | `10 4 * * *` |
| Recommendation email | `0 9 * * *` |
| Weekly digest | `0 8 * * 1` — **stub** |

### 8.3 Runbook pointers

| Situation | Where to go |
|-----------|-------------|
| A paid order never reached the supplier | Bull Board → fulfilment queue → inspect and retry the failed job |
| A customer says they paid but have no Plus | Check `stripe_webhook_events`, then `subscription_state_history`; entitlement cache clears within 60s |
| Social sign-in rejecting everyone | `npm run firebase:check` in Render's Shell tab |
| Referral scored to the wrong country | `PATCH /admin/users/:id/country`, then recompute |
| A referral needs reversing | `POST /admin/referrals/:id/void` |
| Shipping looks mispriced | `npm run shipping:margin` for charged versus actual |
| Dropship submission needs testing | `npm run gardners:dropship-test` |

### 8.4 Configuration changes without a deploy

Pricing, FX, shipping bands, VAT, cart limits, the founding-offer deadline, the referral
campaign window, and `GATING_ENABLED` are all environment-driven. Changing any of them is a
restart, not a release. This is deliberate: these are operator decisions, and an operator
should not need an engineer to make one.

---

## 9. Testing strategy

Vitest, in `src/__tests__/`, run with `npm test`.

The suite is concentrated where a mistake is expensive and a test is cheap — which is
possible because the corresponding logic is written as pure functions of plain data:

| Area | Representative tests |
|------|---------------------|
| Money and pricing | `commerce-pricing`, `money-atomicity`, `first-order-discount`, `subscription-pricing` |
| Shipping | `shipping-options`, `shipping-rate-card`, `shipping-rate-seed`, `parcel` |
| Subscriptions | `subscription-cancel`, `trial-expiry`, `payment-status` |
| Referrals | `referral-scoring`, `referral-links`, `referral-clicks`, `referral-network`, `referral-copy` |
| Search and catalogue | `search-type`, `search-count-probes`, `catalogue-filters`, `isbn-query`, `title-sort-placeholders`, `blended-search-merge`, `shop-band-counts` |
| Recommendations | `vector-recall`, `recommendation-personalization`, `recommendation-sellability`, `dislikes`, `exclusions`, `user-exclusions` |
| Orders and fulfilment | `order-identity`, `order-tracking-lookup`, `orders-list-status-filter`, `guest-account-checkout`, `hdd-parser`, `hdd-dispatch-poll`, `gardners-dropship-guard` |
| Email and notifications | `order-confirmed-email`, `email-unsubscribe-footer`, `unsubscribe-scope`, `merge-notifications` |
| Security and admin | `log-scrubber`, `request-logging`, `blacklist-enforcement`, `customer-activity`, `admin-order-tabs` |

**Requirement:** a fix for a bug in a rule — a scoring award, a shipping band, an unsubscribe
scope — lands with a test that would have caught it. `unsubscribe-scope.test.ts` is the model:
it exists because an earlier version silently stopped follow-request emails for anyone who
left a newsletter, and its comment says so.

Not covered by automated tests, and verified manually: live SFTP round trips to Gardners,
Stripe webhook delivery end to end, Firebase social sign-in, and email rendering across
clients.

---

## 10. Known limitations and open items

| Item | Status |
|------|--------|
| Weekly digest | The cron fires; the active-user query and payload builder are not written. |
| Gardners backorder reconciliation (`BACKORD.TXT`) | Not implemented. |
| Gardners cancellation (`.CRF`/`.CRA`) | Not implemented — a refund is a manual Stripe action plus a call to Gardners, recorded with the `refunded` status. |
| Gardners country/service-code table | Largely unverified; the authoritative `I12d FTP Country List.txt` has to be requested from Gardners. `gardners-countries.ts` documents exactly what is confirmed. |
| Horizontal scaling | Crons and workers run in-process. Verify per-job idempotency, or extract them, before running more than one instance. |
| Referral geolocation | Defeatable by VPN; accepted while no prizes are attached (NFR-C5). |
| FX rates | Configured, not live. They are operator-maintained with a buffer percentage rather than fetched. |
| Open QA issues | Six flagged issues in [`docs/open-issues.md`](open-issues.md), not yet filed as tickets. The two most serious: `GET /user/subscription/plans` calls Stripe four times per request with no cache and no rate limiter, and the subscription reconciliation cron loads every subscriber into memory before making sequential Stripe calls. |

---

## 11. Glossary

| Term | Meaning |
|------|---------|
| **Effective tier** | The tier a user actually has right now, computed at read time from stored tier, status and `trial_ends_at` — not necessarily the stored `tier` column. |
| **Entitlement** | The cached answer to "is this user Plus right now?", read on nearly every authenticated request. |
| **Founding member** | A subscriber on the launch-window price, valid until `FOUNDING_OFFER_ENDS_AT`, preserved across a reactivate. |
| **Guest session** | The pre-account record holding quiz answers; its id is the credential. |
| **Presentment currency** | The currency the buyer is actually charged in, as opposed to the GBP the order is costed in. |
| **Dropship** | Gardners shipping directly to the customer on our behalf; we never hold stock. |
| **`.ORD` / `.ACK` / `.HDD`** | Gardners EDI files: the order we submit, the acknowledgement, the home-delivery dispatch notice carrying tracking. |
| **Full circuit** | A referral chain that closes back on itself — the 30-point award, and the deliberate exception to the depth-2 payout bound. |
| **Sellability** | Whether the shop can actually sell a given book; both the shop and the recommender filter on it. |
| **Static token surface** | An endpoint guarded by `ADMIN_TOKEN`, which authenticates a *deployment*, not a person. |
