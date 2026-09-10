# Kinkané Server

The main API behind Kinkané: the book catalogue, accounts and auth, AI recommendations,
the onboarding quiz, the community feed, the shop, the referral competition, Kinkané Plus
subscriptions, and the staff admin console.

It is one of two independent services sharing a single PostgreSQL database:

| Service | Responsibility |
|---------|---------------|
| **kinkane-server** (this) | Everything a client talks to: users, auth, recommendations, community, shop, referrals, billing, admin console |
| **onix-ingester** | Ingests ONIX 3.1 XML and Gardners feeds into the shared catalogue tables |

Runtime: Node 20+, Express 4, TypeScript, Drizzle ORM over `postgres.js`, Redis (rate
limits, caches, BullMQ), deployed as a single web service on Render.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Available scripts](#available-scripts)
- [Architecture](#architecture)
  - [Two apps, one database](#two-apps-one-database)
  - [Request lifecycle](#request-lifecycle)
  - [Auth model](#auth-model)
  - [Onboarding flow](#onboarding-flow)
  - [AI recommendations](#ai-recommendations)
  - [Kinkané Plus and gating](#kinkané-plus-and-gating)
  - [The shop](#the-shop)
  - [Referral competition](#referral-competition)
  - [Admin surfaces](#admin-surfaces)
  - [Route versioning](#route-versioning)
- [Project structure](#project-structure)
- [Environment variables](#environment-variables)
- [Database](#database)
- [API reference](#api-reference)
- [Rate limiting](#rate-limiting)
- [Search behaviour](#search-behaviour)
- [Background jobs and queues](#background-jobs-and-queues)
- [Email](#email)
- [Push notifications](#push-notifications)
- [Logging and observability](#logging-and-observability)
- [Testing](#testing)
- [Deploying to Render](#deploying-to-render)
- [Firebase setup](#firebase-setup)
- [Further reading](#further-reading)

---

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Node.js | 20+ | Node 22 recommended |
| npm | 9+ | Bundled with Node |
| PostgreSQL | 14+ | Needs `pg_trgm` and `pgvector`; `npm run db:migrate` installs them |
| Redis | 6+ | Rate limits, entitlement/catalogue caches, and the BullMQ queues |
| Google Gemini API key | — | Embeddings + recommendation explanations |
| Resend API key | — | All outbound email |
| Firebase service account | — | Social sign-in and push notifications |
| Stripe account | — | Optional locally; required for subscriptions and the shop |

---

## Quick start

```bash
cd server
npm install
cp .env.example .env      # then fill it in — see Environment variables
npm run db:migrate        # installs extensions, builds indexes, applies migrations
npm run dev               # http://localhost:3000, hot reload
```

Check it is alive:

```bash
curl http://localhost:3000/api/health
```

The server refuses to start if any required environment variable is missing or malformed —
validation happens in `src/config/index.ts` before anything else runs.

The catalogue tables (`books`, `book_contributors`, …) are owned by `onix_ingester`. If you
are running this service against an empty database, apply the ingester's migrations first or
run its `db:init`; this service only reads those tables and will not create them.

### Available scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Start with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled output (production) |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run db:generate` | Generate a Drizzle migration from schema changes |
| `npm run db:migrate` | Install extensions, build concurrent indexes, apply migrations |
| `npm run db:init` | `db:migrate` plus seed data (`src/db/setup.ts`) |
| `npm run db:reset` | Drop all tables and migration records — destructive |
| `npm run admin:create` | Create an admin-console user interactively |
| `npm run seed:demo` | Seed demo content for local work |
| `npm run firebase:check` | Verify Firebase credentials actually work |
| `npm run gardners:dropship-test` | End-to-end test against the Gardners dropship SFTP |
| `npm run shipping:margin` | Report what shipping actually costs versus what is charged |
| `npm run changelog` | Regenerate `CHANGELOG.md` from commit history |

---

## Architecture

### Two apps, one database

Both services point at the same `DATABASE_URL` and own different tables.

- **`onix_ingester` owns** the catalogue and supplier feeds: `books`, `book_contributors`,
  `book_subjects`, `book_genres`, `book_prices`, `genres`, `ingestion_jobs`,
  `ingestion_chunks`, and the `gardners_*` feed tables.
- **`kinkane-server` owns** everything else: accounts, sessions, preferences, community,
  commerce, referrals, subscriptions, notifications, admin.

This service declares read-only Drizzle representations of the catalogue tables so it can
query them without owning their migrations — marked as such in `src/db/schema/books.ts`.
Never generate a migration that alters a table this service does not own.

### Request lifecycle

```
Cloudflare → Render LB → express
  trust proxy = 2          real client IP for rate limits (two proxy hops)
  helmet + cors
  /api/v1/user/subscription/webhook   ← mounted BEFORE express.json (raw body for Stripe)
  express.json (50kb)
  requestLogger            one line per request + a request id on every downstream log
  /admin/queues            Bull Board, static ADMIN_TOKEN
  /admin/gardners/dropship static ADMIN_TOKEN
  /admin/console           per-person admin session (ADMIN_JWT_SECRET)
  /admin/referrals         static ADMIN_TOKEN
  /r/:code[/:slug]         referral links, unversioned by design
  /docs                    OpenAPI UI, only when SWAGGER_PASSWORD is set
  /api/health              unversioned, unthrottled
  /api/v1/*                apiLimiter + feature routers
  /api/v2/books            the only v2 route
  404 → error handler
```

The global error handler in `src/app.ts` has a deliberate rule worth knowing before you
throw: a tagged error with `statusCode < 500` always surfaces its message to the client; a
tagged `5xx` surfaces **only** if it also carries a machine-readable `code`. Everything else
becomes a generic 500, so raw upstream error text cannot leak.

### Auth model

There are three separate identities in this codebase. Do not mix them.

| Identity | Credential | Guard | Used by |
|----------|-----------|-------|---------|
| Customer | `JWT_ACCESS_SECRET` access token + rotating refresh token | `requireAuth` | The mobile app and storefront |
| Admin person | `ADMIN_JWT_SECRET` session token | `requireAdmin` | `/admin/console` — can blacklist customers, export the customer list |
| Deployment | Static `ADMIN_TOKEN` bearer | `requireAdminToken` | Bull Board, Gardners dropship, referral corrections |

The admin secret is deliberately separate and optional: without `ADMIN_JWT_SECRET` the
console refuses every login rather than falling back to the customer secret.

**Customer sign-in** works two ways and produces the same token pair either way:

```
POST /api/v1/auth/signup | /login        email + password
POST /api/v1/auth/social { idToken }     Firebase ID token from Google / Facebook / Apple
  ← { accessToken, refreshToken, user }
```

Firebase is only involved at sign-in. After the first exchange every client uses the same
JWT pair.

**Token lifecycle.** Access tokens are short-lived (`ACCESS_TOKEN_TTL`, default 15 min).
Refresh tokens are stored as a SHA-256 hash — the raw value only ever exists on the client —
and **rotate on every refresh**: the submitted token is deleted and a new pair issued, so a
stolen token dies the moment the real client next refreshes. `POST /auth/logout` deletes the
token server-side, so logout is real.

### Onboarding flow

The whole quiz works without an account. A guest session holds the answers until the person
decides whether to sign up.

```
1. Name  →  2. Three feelings  →  3. Books they enjoyed (≤10)  →  4. Three genres  →  5. Dislikes

     ↓ POST /api/v1/recommendations

6. Ranked recommendations + guestSessionId + expiresAt come back
7. They pick 5  →  POST /api/v1/guest-sessions/:id/selections
8. They register, or they don't
```

**If they register** (`/auth/signup` or `/auth/social` with `guestSessionId`): the account is
created, a 90-day Kinkané Plus trial starts synchronously, and preferences, reading list and
interaction signals migrate to the new account in the background.

**If they don't**: the guest session expires after `GUEST_SESSION_TTL_HOURS` (default 72) and
the cleanup cron deletes it.

### AI recommendations

```
User preferences (feelings, genres, dislikes, liked books)
  → buildPreferenceText()            a natural-language paragraph
  → text-embedding-004               768-dim query vector
  → pgvector cosine search           candidate books, HNSW index
  → dislike + sellability filters    page count, series patterns, unbuyable titles
  → gemini-2.5-flash-lite (batched)  one ≤120-char explanation per book
  → recommendation_cache (48h)       identical preferences return instantly
```

| Step | Model |
|------|-------|
| Query embedding | `GEMINI_EMBEDDING_MODEL` (default `text-embedding-004`) |
| Ranking | pgvector `<=>` cosine distance |
| Explanations | `GEMINI_FLASH_MODEL` (default `gemini-2.5-flash-lite`), with `GEMINI_FLASH_MODEL_FALLBACK` |

**`GEMINI_EMBEDDING_MODEL` must match the model `onix_ingester` used to embed books.** Change
one and you must change the other, or every similarity score is meaningless.

**Caching.** Results are cached for 48 hours against a SHA-256 hash of the preferences.
`displayName` is excluded from the hash, so two people with identical answers share a cache
entry — which is also why the stored explanation holds a `{{name}}` token rather than a real
name, substituted at read time. A new guest session is created regardless of cache state.

**Sellability.** The shop and the recommender share a catalogue, so recommendations are
filtered to books the shop can actually sell (`src/lib/shoppable.ts`). Recommending a title
nobody can buy is worse than recommending one fewer book.

### Kinkané Plus and gating

Every new account starts on a **90-day Kinkané Plus trial**, created synchronously at signup.
There is no downgrade cron: the effective tier is computed at read time, so a trial that has
run out simply reads as `free`.

| Tier | How you get it | What you get |
|------|---------------|--------------|
| **Free** | The default once the trial ends | Quiz, recommendations, browsing, the shop, referrals |
| **Kinkané Plus** | 90-day trial, then a paid monthly or annual plan | Everything, plus the gated features below |

Two pieces of code matter:

- `entitlementsService.get(userId)` (`src/services/subscriptions/entitlements.service.ts`) —
  the read that happens on nearly every authenticated request, cached in Redis for 60s and
  invalidated explicitly on every write that could change it. `past_due` is deliberately
  still entitled: Stripe is retrying the card, and cutting access on the first failure costs
  more than it saves.
- `requirePlus` (`src/middleware/require-plus.middleware.ts`) — the route guard. It responds
  **402 Payment Required** with `code: 'PLUS_REQUIRED'`, never 403, so the app can tell "you
  need to subscribe" apart from "this isn't yours" without parsing prose. It fails **open**:
  if entitlement can't be read, paying subscribers are not locked out.

`GATING_ENABLED` turns the gate on and off without a deploy, so it can ship dark.

Gated today: creating and liking community posts and comments, `GET /explore/personalized`,
recommendation refresh and selections, and writes to the reading list. Deliberately **not**
gated: referrals, the cart, orders, and saved books — buying and inviting are open to
everyone who signed up, and each of those routers says so in a comment.

Billing runs through Stripe (`src/services/subscriptions/`): `checkout.service` creates the
session, `webhooks.service` is the source of truth for state, `state.service` owns writes and
history, `schedules.service` handles plan changes. Note that a Stripe subscription *schedule*
must be released before `cancel_at_period_end` can be set — otherwise a founding member
cannot cancel.

### The shop

```
Cart  →  price quote  →  shipping options  →  Stripe Checkout  →  webhook
                                                                    ↓
                                            order recorded → fulfilment queue → Gardners SFTP
                                                                    ↓
                                                       .ACK / .HDD polling → tracking
```

The design constraint that shapes all of it: **shipping and tax depend on the destination,
but Stripe only collects an address after the price is fixed.** So the destination country is
collected by our own API up front, everything is priced against it, and Stripe's address
collection is locked to that one country. The buyer's address can vary in every way except
the country we priced on.

- **Pricing** (`src/services/commerce/pricing.ts`) is a pure function of amount, country and
  config — no database, no Redis, no request object. Currency resolution, FX from GBP with a
  buffer, shipping bands, VAT and the first-order discount all live there and are driven by
  environment configuration so an operator can change them without a deploy.
- **Fulfilment** (`src/services/commerce/fulfilment.service.ts`) runs on a queue, never in
  the Stripe webhook: submitting an order is an SFTP round trip to a UK server, and payment
  success must not depend on whether a supplier's FTP is up.
- **Bestsellers** (`src/services/commerce/bestsellers.service.ts`) are computed from our own
  `order_items` because no Gardners feed carries a sales rank. It counts copies, never money,
  and when nothing has sold in the window it falls back to trending — labelled, via `source`,
  never silently.
- **Guest checkout** is supported: an order can be looked up with its order number plus
  the buyer's email, and claimed onto an account later.

Refunds are deliberately out of scope for automation — there is no cancellation feed
integration, so a refund is a manual Stripe action plus a call to Gardners. The `refunded`
order status exists so that manual action can be recorded.

### Referral competition

"Around the World": you score by how far your referrals reach, not how many you make.

| Award | Points |
|-------|--------|
| Same country | 1 |
| Same continent | 10 |
| Cross continent | 20 |
| Indirect (same continent) | 5 |
| Indirect (cross continent) | 10 |
| Full circuit | 30 |

Attribution and scoring are deliberately separate services: `referrals.service.ts` owns *who
referred whom*, which is a durable fact, and `referral-scoring.service.ts` owns *what that is
worth*, which is a rule that can change and be recomputed. Nothing in scoring is allowed to
fail a signup.

Country is resolved once, at signup, by `geo.service.ts` (trusted CDN header first, then a
local MaxMind database) and then frozen on the user row — someone travelling must not change
continent mid-competition. The service reports *how* it knows and returns `unknown` rather
than guessing. A VPN defeats IP geolocation; with no prizes attached that exposure is
accepted deliberately (see `docs/referral-system-plan.md`).

Referral links are mounted at the root as `/r/:code/:slug`, not under `/api/v1`, because they
are links a person sends over WhatsApp. That path is also registered as the universal/app
link so an installed app opens straight through.

### Admin surfaces

| Surface | Path | Auth |
|---------|------|------|
| Admin console | `/admin/console` | Per-person session — dashboard, orders, customers, blacklist, reports, banners, notifications |
| Queue dashboard | `/admin/queues` | Static `ADMIN_TOKEN` — Bull Board over the email, push and fulfilment queues |
| Gardners dropship | `/admin/gardners/dropship` | Static `ADMIN_TOKEN` — submit and poll wholesale orders |
| Referral admin | `/admin/referrals` | Static `ADMIN_TOKEN` — map, standings, voiding a referral |

The first admin can be created without a shell via `ADMIN_BOOTSTRAP_EMAIL` /
`ADMIN_BOOTSTRAP_PASSWORD`; `bootstrapFirstAdmin()` runs at startup and does nothing once the
table is non-empty. Otherwise use `npm run admin:create`.

The fulfilment queue is on Bull Board for a different reason than the other two: a failed job
there is a paid order that never reached the supplier, and this is where an operator goes to
find and retry it.

### Route versioning

Everything is under `/api/v1/`. There is exactly one v2 route — `GET /api/v2/books`, which
accepts a `type` parameter that v1 rejects. The rest of the API is **not** duplicated under
v2 on purpose: mirroring routes that behave identically creates pairs to keep in step, and
the first divergence would be an accident rather than a decision.

The v2 router reuses the same `apiLimiter` *instance* as v1, so a client gets one budget
across both versions rather than two.

---

## Project structure

```
server/
├── src/
│   ├── app.ts                    Express app: middleware order, admin mounts, error handler
│   ├── server.ts                 Entry point: crons, workers, admin bootstrap, graceful shutdown
│   ├── config/index.ts           Zod-validated env → typed config (the only place env is read)
│   ├── db/
│   │   ├── index.ts              Drizzle client
│   │   ├── install-extensions.ts pgvector and pg_trgm
│   │   ├── build-concurrent-indexes.ts
│   │   ├── setup.ts / reset.ts   Seed / drop everything (dev)
│   │   ├── seeds/
│   │   └── schema/               34 files — see Database below
│   ├── routes/                   Thin: path, guards, limiter, JSDoc contract
│   │   ├── index.ts              Mounts /health, the v1 router, the v2 router
│   │   ├── admin/index.ts        The staffed console
│   │   └── *.routes.ts           One per feature area
│   ├── controllers/              Parse and validate input, call a service, shape the response
│   ├── services/                 All business logic
│   │   ├── commerce/             cart, checkout, pricing, shipping, fulfilment, orders, bestsellers
│   │   ├── subscriptions/        checkout, webhooks, state, schedules, entitlements
│   │   ├── gardners-dropship/    SFTP connection, order builder, .ACK and .HDD parsers
│   │   └── admin/                dashboard, orders, customers, reports, settings, notifications
│   ├── middleware/               requireAuth, requireAdmin, requirePlus, rate limits, request logger
│   ├── lib/                      Shared primitives: queues, stripe, firebase, gemini, redis,
│   │                             money, isbn, country, logger, log-scrubber, route-helpers
│   ├── emails/                   Templates by kind: transactional, notifications, marketing, reports
│   ├── jobs/                     node-cron schedules
│   ├── workers/                  BullMQ workers: email, push, fulfilment
│   ├── docs/openapi/             The OpenAPI document served at /docs
│   └── __tests__/                Vitest suite
├── drizzle/                      Generated migration SQL
├── changelog/                    One detailed write-up per notable change
├── docs/                         Design docs, client briefs, and the TRD
├── scripts/                      Operational one-offs and checks
├── render.yaml
└── .env.example                  The authoritative, commented environment reference
```

The layering rule is worth stating: **routes are thin, controllers are thin, services hold
the logic.** A route file should tell you the path, the guards and the contract; anything
that makes a decision belongs in a service. The JSDoc block above each route is the contract
— request shape, response shape, and every error code it can return.

---

## Environment variables

`.env.example` is the authoritative reference. It is fully commented — every variable there
explains what it is for and why its default is what it is — and it is kept in step with
`src/config/index.ts`, which validates all of it with Zod at startup. **Read `.env.example`
rather than this section** for the full list; what follows is only the map.

```bash
cp .env.example .env
```

| Group | Variables | Required to boot |
|-------|-----------|------------------|
| Server | `PORT`, `NODE_ENV`, `APP_URL` | Yes |
| Logging | `LOG_LEVEL`, `LOG_REQUEST_PAYLOADS` | No |
| Data | `DATABASE_URL`, `REDIS_URL` | Yes |
| Customer auth | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (≥32 chars each), `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | Yes |
| Admin auth | `ADMIN_JWT_SECRET`, `ADMIN_TOKEN`, `ADMIN_TOKEN_TTL`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` | No (console disabled without them) |
| Firebase | `FIREBASE_SERVICE_ACCOUNT_B64` **or** the three individual fields | Yes |
| Gemini | `GEMINI_API_KEY`, `GEMINI_EMBEDDING_MODEL`, `GEMINI_FLASH_MODEL`, `GEMINI_FLASH_MODEL_FALLBACK` | Yes |
| Email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `SUPPORT_INBOX`, `UNSUBSCRIBE_SECRET` | Yes |
| Onboarding | `GUEST_SESSION_TTL_HOURS` | No |
| Subscriptions | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four `STRIPE_PRICE_PLUS_*`, `FOUNDING_OFFER_ENDS_AT`, `STRIPE_CHECKOUT_*_URL`, `GATING_ENABLED` | No (billing disabled without them) |
| Shop pricing | `SUPPORTED_CURRENCIES`, `DEFAULT_CURRENCY`, `CURRENCY_BY_COUNTRY`, `FX_RATES_FROM_GBP`, `FX_BUFFER_PERCENT`, `FIRST_ORDER_DISCOUNT_PERCENT`, `VAT_*` | No |
| Shipping | `SHIPPING_RATES`, `SHIPPING_USE_RATE_TABLE`, `SHIPPING_FULFILMENT_*`, `SHIPPING_EU_SURCHARGE_PENCE`, `SHIPPING_PEAK_*`, `SHIPPING_MARKUP_PERCENT`, `SHIPPING_FREE_THRESHOLD_*` | No |
| Cart & orders | `CART_MAX_ITEMS`, `CART_MAX_QUANTITY_PER_LINE`, `GUEST_CART_TTL_DAYS`, `STRIPE_ORDER_*_URL` | No |
| Gardners | `GARDNERS_DROPSHIP_SFTP_*`, `GARDNERS_DROPSHIP_ACCOUNT_CODE`, `GARDNERS_DROPSHIP_DEFAULT_TESTING`, `GARDNERS_DROPSHIP_ALLOW_IN_DEV`, `GARDNERS_REGION_BY_COUNTRY`, `GARDNERS_COUNTRY_NAMES_EXTRA` | No |
| Geo & referrals | `GEO_COUNTRY_HEADER`, `MAXMIND_DB_PATH`, `REFERRAL_VIDEO_URL`, `REFERRAL_CAMPAIGN_STARTS_AT`, `REFERRAL_CAMPAIGN_ENDS_AT` | No |
| Docs | `SWAGGER_PASSWORD`, `SWAGGER_SESSION_TTL_HOURS` | No (`/docs` 404s without it) |
| Media | `CLOUDINARY_CLOUD_NAME` | No |

Anything marked "No" degrades a feature rather than the process: without Stripe keys the
billing endpoints return 503, without `SWAGGER_PASSWORD` the docs page does not exist,
without `ADMIN_JWT_SECRET` the console refuses every login. That is the intended behaviour —
the feature is off, not half on.

---

## Database

Around 60 tables, defined across 34 files in `src/db/schema/`. Grouped by what they are for:

| Area | Tables |
|------|--------|
| Accounts | `users`, `refresh_tokens`, `user_providers`, `password_reset_tokens`, `email_verification_tokens`, `email_change_requests` |
| Onboarding & preferences | `guest_sessions`, `user_preferences`, `user_interactions`, `user_books`, `user_disliked_books`, `user_preference_history` |
| Recommendations | `recommendation_cache`, `recommendation_email_log` |
| Community | `posts`, `post_likes`, `comments`, `comment_likes`, `follow_requests`, `user_reports` |
| Commerce | `carts`, `cart_items`, `orders`, `order_items`, `payments`, `saved_books`, `shipping_rates` |
| Subscriptions | `user_subscriptions`, `subscription_events`, `subscription_state_history`, `stripe_webhook_events` |
| Referrals | `referral_codes`, `referrals`, `referral_points`, `referral_clicks`, `referral_invites`, `countries` |
| Notifications | `notifications`, `notification_preferences`, `device_tokens` |
| Admin | `admins`, `admin_notifications`, `announcement_banners`, `contact_messages` |
| Fulfilment | `gardners_dropship_orders`, `gardners_dropship_order_lines`, `gardners_dropship_dispatches` |
| **Read-only** (owned by `onix_ingester`) | `books`, `book_contributors`, `book_subjects`, `book_genres`, `book_prices`, `book_excerpts`, `book_promotions`, `genres`, `gardners_*` feed tables, `ingestion_jobs`, `ingestion_chunks` |

Column-level documentation lives in the schema files themselves, which carry the reasoning
alongside the definition. `docs/technical-requirements.md` covers the entities and their
relationships in prose.

### Running migrations

```bash
npm run db:generate   # after editing a schema file — writes SQL into drizzle/
npm run db:migrate    # applies pending migrations; safe to run on every deploy
```

`db:migrate` also installs the required extensions and builds concurrent indexes before
Drizzle runs, so it works on a fresh database.

> Only generate migrations for tables this service owns. The catalogue and feed tables belong
> to `onix_ingester`.

---

## API reference

The **authoritative, executable reference is the OpenAPI UI at `/docs`**, served from
`src/docs/openapi/` and gated behind `SWAGGER_PASSWORD`. It is generated from the same
source as the running API, so it cannot drift the way a hand-written endpoint list does.
Set `SWAGGER_PASSWORD`, restart, and open `http://localhost:3000/docs`.

For the reasoning behind a particular endpoint — why it returns 402 rather than 403, why a
field is required — read the JSDoc block above the route in `src/routes/`. That is where the
contract and its justification live.

What follows is the index: every route family, where it lives, and how it is guarded.

Base URL: `https://<service>.onrender.com`. All responses are JSON. Errors are
`{ "error": "..." }`, plus `code` and sometimes `details` when the failure is one the client
is expected to handle.

### Public

| Path | Methods | Notes |
|------|---------|-------|
| `/api/health` | `GET` | Unversioned, no rate limit — uptime checks |
| `/api/v1/books` | `GET /`, `/search`, `/recommendations`, `/:id`, `/:id/similar` | Catalogue browse and search |
| `/api/v2/books` | `GET /` | Same as v1 plus the `type` filter |
| `/api/v1/authors` | `GET /search` | |
| `/api/v1/genres` | `GET /` | |
| `/api/v1/settings` | `GET /banners` | Storefront announcement strips; only enabled banners |
| `/api/v1/contact` | `POST /` | Public by design — the people who need it often cannot log in |
| `/api/v1/unsubscribe` | `GET /` | Signed token, no session |
| `/r/:code`, `/r/:code/:slug` | `GET` | Referral links, root-mounted |

### Onboarding

| Path | Methods | Guard |
|------|---------|-------|
| `/api/v1/recommendations` | `POST /`, `GET /preferences`, `PATCH /refresh`, `POST /selections` | `POST /` is open; refresh and selections need auth + Plus |
| `/api/v1/guest-sessions` | `GET /:id`, `POST /:id/selections`, `POST /:id/referral` | Session id is the credential |

### Account

| Path | Methods | Guard |
|------|---------|-------|
| `/api/v1/auth` | `POST /signup`, `/login`, `/social`, `/refresh`, `/logout`, `/forgot-password`, `/reset-password`, `/verify-email`, `/change-password`; `GET /me`; `DELETE /account` | Mixed — see the route file |
| `/api/v1/user/settings` | `GET /`, `PATCH /profile`, `PATCH /shelf-visibility` | `requireAuth` |
| `/api/v1/user/email-change` | `POST /request`, `/verify`, `/resend`; `GET /cancel` | `requireAuth` (cancel uses a signed link) |
| `/api/v1/user/notification-preferences` | `GET /`, `PATCH /` | `requireAuth` |
| `/api/v1/user/notifications` | `GET /`, `PATCH /read` | `requireAuth` |
| `/api/v1/user/device-tokens` | `POST /`, `DELETE /:fcmToken` | `requireAuth` |
| `/api/v1/user/preference-history` | `GET /` | `requireAuth` |

### Library and discovery

| Path | Methods | Guard |
|------|---------|-------|
| `/api/v1/user-books` | `GET /`, `PUT /:bookId`, `DELETE /:bookId`, `POST /reset`, `POST|DELETE /:bookId/like` | `requireAuth`; writes also `requirePlus` |
| `/api/v1/explore` | `GET /trending`, `/bestsellers`, `/personalized` | `/personalized` needs auth + Plus |

### Community

| Path | Methods | Guard |
|------|---------|-------|
| `/api/v1/community` | Posts, comments, likes, `GET /search` | `requireAuth`; creating and liking also `requirePlus` |
| `/api/v1/users` | Profiles, books, followers/following, follow requests | `requireAuth` |
| `/api/v1/reports` | `POST /` | `requireAuth` |

### Shop

Deliberately **no `requirePlus` anywhere** — buying is open to every signed-up user.

| Path | Methods | Guard |
|------|---------|-------|
| `/api/v1/cart` | `GET /`, `POST /items`, `PATCH /items/:bookId`, `DELETE /items/:bookId`, `DELETE /` | `requireAuth` — the stored cart |
| `/api/v1/cart` | `POST /price`, `POST /shipping-options`, `POST /checkout` | `optionalAuth` — a guest sends the lines with the request; nothing is stored for a visitor who never signs up |
| `/api/v1/orders` | `GET /`, `GET /:id`, `POST /claim` | `requireAuth` |
| `/api/v1/orders` | `POST /lookup`, `POST /track` | Unauthenticated — `track` takes the order number plus the buyer's email, `lookup` the reference plus the access token |
| `/api/v1/saved-books` | `GET /`, `POST /`, `DELETE /:bookId` | `requireAuth` |
| `/api/v1/payments` | `GET /:reference` | Confirmation by reference — subscriptions and orders alike |

### Subscriptions

| Path | Methods | Guard |
|------|---------|-------|
| `/api/v1/user/subscription` | `GET /`, `GET /history`, `GET /plans`, `POST /checkout-session`, `POST /change`, `POST /cancel`, `POST /reactivate` | `requireAuth` |
| `/api/v1/user/subscription/webhook` | `POST /` | Stripe signature — mounted before `express.json` |

Cancellation always takes effect at the end of the paid period, never immediately, and is
idempotent. `POST /change` with `plan: 'free'` is the same action and also requires a reason,
so every cancellation reaches the reasons ledger regardless of which button triggered it.

### Referrals

Open to every signed-up user — `requireAuth` only, never `requirePlus`.

| Path | Methods |
|------|---------|
| `/api/v1/referrals` | `GET /me`, `/me/stats`, `/me/network`, `/leaderboard`, `/analytics`, `/map`; `POST /me/rotate`, `/clicks`, `/shares`, `/invite` |

### Admin

| Path | Auth | Endpoints |
|------|------|-----------|
| `/admin/console` | Admin session | `POST /auth/login`, `GET /auth/me`, `/dashboard`, `/badges`, orders (+ `/orders/export`), `/shipping-margin`, customers (+ export, blacklist), reports, `/settings/banners`, notifications |
| `/admin/referrals` | `ADMIN_TOKEN` | `GET /tree`, `GET /leaderboard`, `POST /:id/void` |
| `/admin/users/:id/country` | `ADMIN_TOKEN` | `PATCH` — correct a mis-resolved country |
| `/admin/gardners/dropship` | `ADMIN_TOKEN` | `POST /orders`, `GET /orders/:id`, `POST /orders/:id/poll-ack` |
| `/admin/queues` | `ADMIN_TOKEN` | Bull Board UI |

---

## Rate limiting

Limits are per IP (per user where the request is authenticated), counted in Redis so they
hold across instances. Exceeding one returns `429` with `RateLimit-Limit`,
`RateLimit-Remaining` and `RateLimit-Reset` headers.

| Route | Limit | Window |
|-------|-------|--------|
| All `/api/v1` and `/api/v2` | 300 | 15 min |
| `POST /auth/signup` | 10 | 1 hour |
| `POST /auth/login`, `/auth/social` | 20 | 15 min |
| `POST /auth/refresh` | 60 | 15 min |
| `POST /auth/forgot-password`, `/reset-password` | 5 | 1 hour |
| `POST /auth/verify-email` | 10 | 1 hour |
| Resend verification email | 5 | 1 hour |
| Email change | 5 | 1 hour |
| `POST /recommendations` and refresh | 20 | 1 hour |
| Checkout (cart and subscription) | 20 | 1 hour |
| Payment confirmation polling | 60 | 1 min |
| Guest order lookup / tracking | 10 | 15 min |
| Follow requests | 30 | 1 hour |
| `POST /contact` | 3 | 1 hour |
| Admin console login | 10 | 15 min |
| `GET /api/health` | none | — |

`app.set('trust proxy', 2)` is what makes these correct in production: Render fronts every
service with its own Cloudflare, so a request passes two proxies before reaching us. Peeling
only one hop left `req.ip` holding a Cloudflare edge address — which meant one shared rate
limit bucket for every anonymous user behind that PoP. If the proxy chain ever changes, that
number is what changes.

---

## Search behaviour

When `q` is supplied to `GET /api/v1/books`:

1. **ISBN** — a query that parses as an ISBN-10 or ISBN-13 goes straight to a lookup.
2. **Full-text search** — `plainto_tsquery('english', q)` against the `search_vector`
   tsvector column maintained by a database trigger, ranked by `ts_rank`.
3. **Trigram fallback** — if FTS returns nothing, a `pg_trgm` similarity query on the title
   catches typos: "Filosopher Stone" still finds the book.
4. **Filters combine** — `q` intersects with every other filter, so
   `q=rowling&genre=childrens_fiction` returns only books matching both.

Title sorting has its own rules: placeholder titles sink to the bottom, and titles starting
with a number or symbol sort below A–Z rather than above it.

> **Database collation:** this database's ctype is `C`, so POSIX regex classes are
> ASCII-only. Anything touching accented text needs `COLLATE "und-x-icu"`.

---

## Background jobs and queues

Two mechanisms, chosen for different reasons. **Cron jobs** run on a schedule inside the web
process and do bulk database work. **BullMQ queues** carry per-item work that must survive a
restart, retry on failure, and never block an HTTP response.

### Cron schedule

All of these run in-process via `node-cron`, are started in `src/server.ts`, and are stopped
cleanly on `SIGTERM`/`SIGINT`.

| Job | Schedule (UTC) | What it does |
|-----|---------------|--------------|
| Guest cleanup | `0 */6 * * *` | Deletes guest sessions past `expires_at` |
| Trial expiry | `0 * * * *` | Flips trials that have run out to free |
| Order reconciliation | `*/30 * * * *` | Polls Gardners for `.ACK` acknowledgements, then for `.HDD` dispatches |
| Subscription reconciliation | `15 3 * * *` | Re-syncs subscription state against Stripe |
| Preference history cleanup | `20 3 * * *` | Trims old preference snapshots |
| Interaction cleanup | `40 3 * * *` | Trims old `user_interactions` rows |
| Bestseller refresh | `10 4 * * *` | Drops the cached bestseller windows so the day's first reader gets a correctly-bounded `7d` |
| Recommendation email | `0 9 * * *` | Emails a new recommendation to each opted-in user, at most once every 5 days |
| Weekly digest | `0 8 * * 1` | Mondays — **stub**: the cron fires but the active-user query is not written yet |

### Queues

| Queue | Worker | Why it is a queue |
|-------|--------|-------------------|
| `email` | `src/workers/email.worker.ts` | Retries through a transient Resend outage; priority lanes; concurrency capped at 5 |
| `push` | `src/workers/push.worker.ts` | Same, plus stale FCM tokens get pruned as they are discovered |
| `fulfilment` | `src/workers/fulfilment.worker.ts` | Submitting an order is an SFTP round trip; payment success must not depend on a supplier's FTP being up |

Retry policy is 3 attempts with exponential backoff (2s, 4s). Exhausted jobs stay in Redis in
the `failed` state so they can be inspected and retried from **Bull Board at `/admin/queues`**
(bearer `ADMIN_TOKEN`).

**Graceful shutdown** waits for in-flight jobs: the email worker finishes its active send,
and the fulfilment worker finishes its SFTP write — killing that one mid-write would leave a
partial `.ORD` file on Gardners' server.

---

## Email

Every email goes through Resend, and **always through the queue** — never send directly from
a request path.

```ts
import { enqueueEmail } from '../lib/email-queue';

await enqueueEmail('welcome', { to: user.email, name: user.name });
await enqueueEmail('trial-ending', { to: user.email, name: user.name, daysLeft: 7 });
```

The helper is fully typed against `EmailJobMap`, so a mismatched payload is a compile error.
Templates live in `src/emails/`, grouped by kind, sharing `emails/lib/layout.ts`.

Priorities are set per job type — lower number wins — so a password reset never queues behind
a newsletter:

| Priority | Jobs |
|----------|------|
| 1 | `password-reset`, `password-changed`, `account-deleted`, `order-confirmed`, `email-change-otp`, `email-change-notify`, all three `subscription-*` |
| 3 | `verify-email` |
| 5 | `welcome`, `trial-ending`, `referral-invite` |
| 7 | `new-recommendation`, `follow-request`, `follow-accepted`, `rate-review-reminder` |
| 8 | `weekly-digest` |
| 10 | `newsletter` |

One-click unsubscribe (`UNSUBSCRIBE_SECRET`) switches off exactly three things:
`marketingEmails`, `newBookSuggestions` and `rateReviewReminders`. It deliberately does not
touch follow requests, trial-ending, billing or security email — those are either another
person contacting the user or something about their own account they need to see. That rule
is enforced by `src/__tests__/unsubscribe-scope.test.ts`, which exists because an earlier
version silently stopped follow-request emails for anyone who left a newsletter.

### Resend setup

1. Create an API key with **Sending access** at [resend.com](https://resend.com).
2. Add and verify the sender domain under **Domains** — it must match `EMAIL_FROM` or every
   send is rejected.
3. Set `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` and `SUPPORT_INBOX`.

---

## Push notifications

Push runs on Firebase Cloud Messaging through the same Admin SDK used for social sign-in.
Devices register with `POST /api/v1/user/device-tokens`; `sendPush(userId, payload)` fans out
to every token that user has registered, and tokens FCM reports as unregistered or invalid
are deleted as they are found, so the table self-cleans.

If Firebase is not initialised the send is skipped with a warning rather than throwing — a
missing push credential must not fail the action that triggered the notification.

In-app notifications are separate and durable: they live in `notifications`, are read through
`/api/v1/user/notifications`, and respect `notification_preferences`.

---

## Logging and observability

Structured JSON to stdout, read in Render's log explorer (there is no Sentry — it was
removed deliberately in favour of the platform's own tooling).

- **One line per request** — method, path, status, duration — plus a request id threaded
  into every downstream log line for that request.
- **Inbound `X-Request-Id` values are prefixed** so a client cannot spoof another request's id.
- **Query strings are dropped** from the request log: tokens end up in them.
- **`lib/log-scrubber.ts`** redacts session tokens, passwords and other named secrets from
  every log line.
- **`LOG_REQUEST_PAYLOADS`** attaches body, query and params to each line. It follows
  `NODE_ENV` by default — on in development, off elsewhere — and that default is the point:
  a body is caller-controlled, and the next endpoint to accept a secret under a name nobody
  added to the scrubber would otherwise write it in the clear into a log aggregator with a
  much longer retention than anyone's memory of having turned this on.
- **`LOG_LEVEL`** overrides the default (`debug` in development, `info` elsewhere).

Health check: `GET /api/health`, unversioned and unthrottled, is what Render polls.

---

## Testing

```bash
npm test          # once
npm run test:watch
```

Vitest, with the suite in `src/__tests__/`. The coverage is deliberately concentrated on the
things that are expensive to get wrong and cheap to test in isolation: pricing and money
arithmetic, shipping bands and rate cards, subscription cancellation and pricing, referral
scoring and links, search and catalogue filters, the Gardners parsers, and the log scrubber.

That is why so much logic is written as pure functions of plain data — `commerce/pricing.ts`
and `referral-scoring.service.ts` are the clearest examples. The interesting cases (a
circuit that closes six levels down, a parcel that crosses a weight band) are miserable to
set up as database fixtures and trivial to express as arrays.

---

## Deploying to Render

`render.yaml` defines the service. It runs on the same PostgreSQL and Redis instances as
`onix_ingester`.

```
Build:       npm install && npm run build
Pre-deploy:  npm run db:init          (idempotent — safe on every deploy)
Start:       node dist/server.js
Health:      /api/health
```

`DATABASE_URL` and `REDIS_URL` are injected from the linked resources; `JWT_ACCESS_SECRET`
and `JWT_REFRESH_SECRET` are generated by Render. Everything else is set in the dashboard.

`GEO_COUNTRY_HEADER` is set to `cf-ipcountry`, which is safe despite being a client-settable
header name: Render's own Cloudflare overwrites any `cf-*` header a client sends (verified
2026-09-02 — a request carrying a forged `cf-ipcountry: ZZ` arrived as the true `GH`). That
Cloudflare is Render's rather than ours, so it is undocumented and could go away; if it does,
`geo.service` degrades to a null country rather than trusting the header.

Crons and workers run inside the web process, so **more than one instance means every cron
fires in every instance.** The jobs that would be dangerous under that are written to be
idempotent — the trial flip re-checks its guards inside the `UPDATE`, dispatch inserts are
arbitrated by a unique constraint — but treat that as a property to verify per job before
scaling out, not a blanket guarantee.

---

## Firebase setup

### 1. Create the project

Create a project at [console.firebase.google.com](https://console.firebase.google.com), then
under **Authentication → Sign-in method** enable Google, Facebook and Apple.

### 2. Generate a service account key

**Project Settings → Service accounts → Generate new private key** downloads a JSON file.
Base64-encode the whole file and set the result as one variable:

```bash
base64 -i serviceAccountKey.json
```

```
FIREBASE_SERVICE_ACCOUNT_B64=<the base64 output>
```

The server decodes it and reads `project_id`, `client_email` and `private_key` out of the JSON.

**Use this form for Render and any other dashboard-configured environment.** A raw PEM key
does not survive a web form intact: dashboards store the value verbatim, so wrapping quotes
become part of the string and multi-line pastes can arrive with the newlines flattened.
Either way OpenSSL rejects the key and Firebase fails to start with the unhelpful
`error:1E08010C:DECODER routines::unsupported`. Base64 contains nothing a form can mangle.

<details>
<summary>Alternative: the three fields individually</summary>

Still supported, and fine in a local `.env` where dotenv handles the quoting:

```
FIREBASE_PROJECT_ID      ← "project_id"
FIREBASE_CLIENT_EMAIL    ← "client_email"
FIREBASE_PRIVATE_KEY     ← "private_key"
```

Keep the private key wrapped in double quotes and leave the `\n` characters as-is. These are
read only when `FIREBASE_SERVICE_ACCOUNT_B64` is unset.

</details>

### Checking the credentials work

```bash
npm run firebase:check
```

Reports which credential source is in use, whether the private key is well-formed PEM, and
whether Google actually accepts it (it mints a real access token). Pass a Firebase ID token —
`npm run firebase:check -- <idToken>` — to also verify the exact path `POST /api/v1/auth/social`
takes. It prints no secret material; keys are reported by length and SHA-256 prefix, so the
output is safe to paste into a ticket. Run it in Render's **Shell** tab to check the deployed
environment without waiting on a deploy and a login attempt.

### Getting an ID token to test with

Call `firebaseUser.getIdToken()` in the mobile app after signing in. Tokens last one hour.
`scripts/google-signin-test.html` does the same from a browser via a real Google sign-in
popup — see the comment at the top of that file. It needs a **Web** app registered in the
Firebase project first; only Android and iOS are registered today.

### Failure behaviour

The server exits at startup if neither credential form is configured, and throws with a
diagnostic message if the key is present but unparseable. Firebase backs social sign-in and
push, so a server running without it would pass health checks while rejecting every Google
login.

### Mobile integration

The app signs in with the provider, then POSTs `firebaseUser.getIdToken()` to
`POST /api/v1/auth/social`. For onboarding, `guestSessionId` must survive the OAuth redirect:
embed it in Firebase's `customParameters` state before initiating sign-in, read it back in
the callback, and include it in the request body.

- **Facebook** needs an App ID and secret in Firebase's Facebook provider settings.
- **Apple** needs an Apple Developer account, and is mandatory on iOS if the app offers any
  other social login (App Store guideline 4.8).

### Service account security

Never commit the service account JSON or your `.env`. If a key is ever pasted somewhere it
shouldn't be — a chat, a ticket, a log — treat it as compromised: generate a new one under
**Service accounts** and delete the old key, rather than assuming it went unnoticed.

---

## Further reading

| Document | What it covers |
|----------|---------------|
| [`docs/technical-requirements.md`](docs/technical-requirements.md) | The TRD — scope, requirements, data model, integrations, non-functional requirements |
| [`CLAUDE.md`](CLAUDE.md) | Commit message and changelog conventions for this repo |
| [`CHANGELOG.md`](CHANGELOG.md) | One line per commit, generated |
| [`changelog/`](changelog/) | Detailed write-up per notable change — what, why, what was left out, how it was verified |
| [`docs/ecommerce-plan.md`](docs/ecommerce-plan.md) | The shop's original design |
| [`docs/referral-system-plan.md`](docs/referral-system-plan.md) | Referral competition design and its accepted risks |
| [`docs/mobile-integration.md`](docs/mobile-integration.md) | What the mobile client needs from this API |
| [`docs/shop-integration.md`](docs/shop-integration.md) | What the storefront needs |
| [`docs/order-tracking-client-brief.md`](docs/order-tracking-client-brief.md) | Order and tracking flow for clients |
| [`docs/delivery-options-client-brief.md`](docs/delivery-options-client-brief.md) | Shipping options as the client sees them |
| [`docs/open-issues.md`](docs/open-issues.md) | Known issues not yet filed |

### Conventions

- **Commits** are Conventional Commits with a plain-language description — `CHANGELOG.md` is
  generated from them and read by non-engineers. Anything beyond a trivial change also gets a
  write-up in `changelog/`. See `CLAUDE.md`.
- **Routes are thin, services hold the logic**, and the JSDoc above a route is its contract.
- **Comments explain why, not what.** The codebase is unusually heavily commented on purpose:
  the non-obvious decisions — why a 402 rather than a 403, why two proxy hops, why fulfilment
  is off the webhook path — are recorded where the code is, and that convention is worth
  keeping.
