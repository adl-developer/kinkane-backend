# Kinkane Server

The main API for the Kinkane book platform. Serves book catalogue data, handles user authentication, AI-powered book recommendations, and the pre-registration onboarding flow.

This is one of two independent services that share the same PostgreSQL database:

| Service | Responsibility |
|---------|---------------|
| **kinkane-server** (this) | Serves books to clients, manages users, auth, recommendations, and onboarding |
| **onix-ingester** | Ingests ONIX 3.1 XML feeds from Cloudflare R2 into PostgreSQL |

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Setup](#project-setup)
- [Architecture](#architecture)
  - [Two apps, one database](#two-apps-one-database)
  - [Onboarding flow](#onboarding-flow)
  - [AI recommendations](#ai-recommendations)
  - [Auth flow](#auth-flow)
  - [Route versioning](#route-versioning)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [API Reference](#api-reference)
  - [Health](#health)
  - [Auth](#auth)
  - [Books](#books)
  - [Recommendations](#recommendations)
  - [Guest Sessions](#guest-sessions)
  - [User Books](#user-books)
  - [User Settings](#user-settings)
- [Subscriptions](#subscriptions)
- [Rate Limiting](#rate-limiting)
- [Search Behaviour](#search-behaviour)
- [Background Jobs](#background-jobs)
  - [Guest session cleanup](#guest-session-cleanup)
  - [Email queue](#email-queue)
  - [Weekly digest](#weekly-digest)
- [Email](#email)
- [Running Locally](#running-locally)
- [Deploying to Render](#deploying-to-render)
- [Firebase Setup](#firebase-setup)

---

## Prerequisites

| Requirement | Minimum version | Notes |
|-------------|----------------|-------|
| Node.js | 20+ | Node 22 recommended |
| npm | 9+ | Bundled with Node |
| PostgreSQL | 14+ | Must have `pg_trgm` and `pgvector` extensions enabled (handled by `onix_ingester`) |
| Redis | 6+ | Required for rate limiting and the email job queue |
| Google Gemini API key | — | Same key used by `onix_ingester` — see [AI Recommendations](#ai-recommendations) |
| SendGrid API key | — | Required for transactional and marketing emails — see [Email](#email) |

---

## Project Setup

### 1. Clone and install

```bash
cd server
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in all values. See [Environment Variables](#environment-variables) for the full list.

### 3. Run migrations

```bash
npm run db:migrate
```

Creates all tables owned by this service. Book-related tables are owned by `onix_ingester` — this service only reads from them.

### 4. Start the development server

```bash
npm run dev
```

Server starts on `http://localhost:3000` with hot reload.

### Available scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output (production) |
| `npm run db:generate` | Generate a new Drizzle migration from schema changes |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:reset` | Drop all tables and migration records — run `db:migrate` after to start fresh |

---

## Architecture

### Two apps, one database

Both `kinkane-server` and `onix_ingester` point to the same `DATABASE_URL`. They manage separate tables:

- `onix_ingester` owns: `books`, `book_contributors`, `book_subjects`, `book_genres`, `book_prices`, `genres`
- `kinkane-server` owns: `users`, `refresh_tokens`, `user_providers`, `user_subscriptions`, `recommendation_cache`, `guest_sessions`, `user_preferences`, `user_interactions`, `user_books`, `password_reset_tokens`

The server defines read-only Drizzle schema representations of the book tables so it can query them without owning their migrations. This is clearly marked in `src/db/schema/books.ts`.

---

### Onboarding flow

New users go through a guided wizard before creating an account. The entire flow is designed to work without an account — a temporary guest session holds the user's data.

```
1.  User enters their name
2.  Selects 3 feelings (how they want to feel while reading)
3.  Selects up to 10 books they've enjoyed
4.  Selects 3 genres
5.  Selects reading dislikes

       ↓  POST /api/v1/recommendations

6.  Server generates ranked book recommendations + creates a guest session
7.  Client receives: recommendations + guestSessionId + expiresAt

8.  User picks 5 books from the results

       ↓  POST /api/v1/guest-sessions/:id/selections

9.  Server saves the 5 chosen books to the guest session

10. User chooses: create account or skip
```

**If they register:**
`POST /api/v1/auth/signup` or `/auth/social` with `guestSessionId` (required) → server creates the account, starts a 90-day Kinkane Plus trial, and migrates all onboarding data (preferences, reading list, interaction signals) to the new account in the background.

**If they skip:**
The guest session expires after `GUEST_SESSION_TTL_HOURS` (default 72 hours / 3 days). The cleanup cron deletes it automatically.

---

### AI recommendations

Recommendations are powered by two Gemini models working together:

| Step | Model | Purpose |
|------|-------|---------|
| Query embedding | `text-embedding-004` | Converts user preferences to a 768-dim vector |
| Ranking | pgvector (`<=>`) | Cosine similarity against stored book embeddings |
| Explanations | `gemini-2.5-flash-lite` | Generates a ≤120-char explanation per book |

**Important:** `GEMINI_EMBEDDING_MODEL` must match the model `onix_ingester` used to embed books. Both default to `text-embedding-004`. If you change one, change both.

**Recommendation flow:**

```
User preferences (feelings, genres, dislikes, liked books)
  → buildPreferenceText()         natural language paragraph
  → text-embedding-004            768-dim query vector
  → pgvector cosine search        top 250 most similar books
  → dislike SQL filters           page count, series patterns
  → gemini-2.5-flash-lite (batch) one ≤120-char explanation per book
  → recommendation_cache (48h)    same preferences return instantly
  → guest session created         guestSessionId returned to client
```

**Caching:** Results are cached in `recommendation_cache` for 48 hours keyed on a SHA-256 hash of the preferences. `displayName` is excluded from the hash — two users with identical preferences but different names share the same cached results. A new guest session is always created regardless of cache state.

**Cost:** At `gemini-2.5-flash-lite` rates, a full uncached request (250 books, 250 explanations) costs roughly $0.01. Cached requests cost nothing.

---

### Auth flow

Supports two sign-in methods that both produce the same token pair:

**Email/password**
```
POST /api/v1/auth/signup or /login
  ← { accessToken, refreshToken, user }
```

**Social (Google, Facebook, Apple) via Firebase**
```
Mobile app signs in with provider via Firebase SDK
  ← Firebase ID token

POST /api/v1/auth/social  { idToken: "<firebase-id-token>" }
  ← { accessToken, refreshToken, user }
```

Firebase is only involved at sign-in time. After the first exchange the mobile app uses the same JWT pair as email/password users — `requireAuth` middleware is identical for both.

**Token lifecycle**
```
Client stores accessToken + refreshToken.

Every request → Authorization: Bearer <accessToken>   (15 min TTL)

When access token expires:
POST /api/v1/auth/refresh  { refreshToken }
  ← { accessToken, refreshToken }   ← store the NEW refreshToken; old one is deleted

POST /api/v1/auth/logout  { refreshToken }
  → refresh token deleted from DB, immediately invalidated
```

Refresh tokens are stored in PostgreSQL as a SHA-256 hash — the raw token is only ever held by the client. **Token rotation is enforced on every refresh** — the submitted token is deleted and a new pair is issued. This means a stolen token becomes invalid the moment the legitimate client next refreshes. Logout is real: the token cannot be used again even if intercepted.

---

### Route versioning

All routes are versioned under `/api/v1/`. Adding a v2 means creating a new router and mounting it at `/v2` in `src/routes/index.ts` — nothing else changes.

```
/api/health                        — unversioned, no rate limit (uptime checks)
/api/v1/auth/...                   — auth routes
/api/v1/books/...                  — book routes
/api/v1/recommendations            — AI recommendation route
/api/v1/guest-sessions/...         — onboarding guest session routes
/api/v1/user-books/...             — authenticated user reading list routes
/api/v1/user/settings/...          — authenticated user settings routes
```

---

## Project Structure

```
server/
├── src/
│   ├── config/index.ts              # Env validation (zod), typed config
│   ├── db/
│   │   ├── index.ts                 # Drizzle client
│   │   ├── reset.ts                 # Drops all tables (dev utility)
│   │   └── schema/
│   │       ├── users.ts             # users, refresh_tokens, user_providers, shelfVisibilityEnum
│   │       ├── books.ts             # Read-only book tables (owned by onix_ingester)
│   │       ├── recommendations.ts   # recommendation_cache
│   │       ├── onboarding.ts        # guest_sessions, user_preferences, user_interactions, user_books
│   │       ├── subscriptions.ts     # user_subscriptions + getEffectiveTier() helper
│   │       ├── password-reset-tokens.ts  # password_reset_tokens
│   │       └── index.ts
│   ├── emails/
│   │   ├── index.ts                 # Re-exports all email senders
│   │   ├── transactional/
│   │   │   ├── welcome.ts           # New user welcome
│   │   │   ├── verify-email.ts      # Email verification OTP
│   │   │   ├── password-reset.ts    # Password reset link (forgot password flow)
│   │   │   ├── password-changed.ts  # Security notice after password change
│   │   │   └── account-deleted.ts   # Goodbye email after account deletion
│   │   ├── notifications/
│   │   │   ├── trial-ending.ts      # Trial expiry warning
│   │   │   └── new-recommendation.ts
│   │   ├── marketing/
│   │   │   └── newsletter.ts        # Bulk marketing sends
│   │   └── reports/
│   │       └── weekly-digest.ts     # Weekly reading summary
│   ├── jobs/
│   │   ├── guest-cleanup.cron.ts    # Deletes expired guest sessions every 6 hours
│   │   └── weekly-digest.cron.ts    # Enqueues digest emails every Monday at 08:00 UTC
│   ├── lib/
│   │   ├── email-queue.ts           # BullMQ queue, job type map, enqueueEmail() helper
│   │   ├── firebase.ts              # Firebase Admin SDK initialisation
│   │   ├── gemini.ts                # Gemini embedding + explanation helpers
│   │   ├── logger.ts                # Structured JSON logger
│   │   ├── redis.ts                 # ioredis client (rate limiting)
│   │   └── sendgrid.ts              # SendGrid client initialisation
│   ├── workers/
│   │   └── email.worker.ts          # BullMQ worker — processes all email job types
│   ├── services/
│   │   ├── auth.service.ts          # signup, login, refresh, logout, socialLogin, forgotPassword, resetPassword, changePassword, deleteAccount, getMe
│   │   ├── books.service.ts         # list (FTS + trigram fallback), suggestions, getById
│   │   ├── guest.service.ts         # create, saveSelections, getById
│   │   ├── recommendations.service.ts  # pgvector search, Gemini calls, caching
│   │   ├── user-books.service.ts    # reading list CRUD, resetLibrary
│   │   └── user-settings.service.ts # getUserSettings, updateShelfVisibility
│   ├── controllers/
│   │   ├── auth.controller.ts
│   │   ├── books.controller.ts
│   │   ├── guest.controller.ts
│   │   ├── recommendations.controller.ts
│   │   ├── user-books.controller.ts
│   │   └── user-settings.controller.ts
│   ├── middleware/
│   │   ├── auth.middleware.ts       # requireAuth — verifies Bearer JWT
│   │   └── rate-limit.middleware.ts # Per-route rate limiters
│   ├── routes/
│   │   ├── index.ts                 # Mounts /health + v1 router
│   │   ├── auth.routes.ts
│   │   ├── books.routes.ts
│   │   ├── guest.routes.ts
│   │   ├── recommendations.routes.ts
│   │   ├── user-books.routes.ts
│   │   └── user-settings.routes.ts
│   ├── app.ts                       # Express app, middleware, Bull Board at /admin/queues
│   └── server.ts                    # Entry point, starts worker + cron jobs, graceful shutdown
├── drizzle/                         # Migration SQL files
├── drizzle.config.ts
├── render.yaml
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Environment Variables

Create a `.env` file from `.env.example`. All values are validated at startup — the server refuses to start if anything is missing or malformed.

```env
# Server
PORT=3000
NODE_ENV=development

# PostgreSQL — same database as onix_ingester
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Redis — used for rate limiting and the email job queue
REDIS_URL=redis://localhost:6379

# JWT secrets — must be at least 32 characters each, keep separate
JWT_ACCESS_SECRET=your_access_token_secret_min_32_chars
JWT_REFRESH_SECRET=your_refresh_token_secret_min_32_chars

# Token lifetimes in seconds
ACCESS_TOKEN_TTL=900        # 15 minutes
REFRESH_TOKEN_TTL=2592000   # 30 days

# Firebase Admin SDK — from your Firebase project service account JSON
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Google Gemini — same API key as onix_ingester
# GEMINI_EMBEDDING_MODEL must match the model used to embed books (default: text-embedding-004)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_EMBEDDING_MODEL=text-embedding-004
GEMINI_FLASH_MODEL=gemini-2.5-flash-lite

# Guest session lifetime in hours. Default: 72 (24 * 3 = 3 days).
# Set to 168 for a full week, 24 for a single day, etc.
GUEST_SESSION_TTL_HOURS=72

# SendGrid — https://app.sendgrid.com/settings/api_keys
SENDGRID_API_KEY=SG.your-api-key-here
EMAIL_FROM=hello@kinkane.com
EMAIL_FROM_NAME=Kinkane

# Frontend base URL — used to build links in emails (e.g. password reset)
# Use http://localhost:3001 (or your frontend's port) in development
APP_URL=https://kinkane.com
```

**Why two JWT secrets?** Access and refresh tokens are signed with different secrets. A leaked access token cannot be used to forge a refresh token.

**Firebase private key newlines:** The private key in service account JSON contains literal `\n` characters. When pasting into Render or a `.env` file, wrap the value in double quotes and keep the `\n` literals — the server unescapes them automatically at startup.

**Gemini embedding model:** Must be identical to the value used by `onix_ingester` when it generated book embeddings. If the ingester used a different model, the query vector and book vectors will be in different spaces and similarity results will be meaningless.

---

## Database

### Tables owned by this service

#### users

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| name | varchar(500) NOT NULL | Freeform — no first/last splitting |
| email | varchar(500) UNIQUE NOT NULL | Stored lowercase |
| password_hash | varchar(500) | Nullable — NULL for social-only accounts |
| photo_url | varchar(1000) | Profile photo from social provider, if provided |
| email_verified | boolean | Default false; set true when provider confirms email |
| shelf_visibility | enum `public \| friends \| private` | Default `private` — controls who can view the user's reading list |
| created_at / updated_at | timestamptz | |

#### refresh_tokens

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer FK → users.id CASCADE DELETE | |
| token_hash | varchar(64) UNIQUE | SHA-256 hex of the raw token — raw never stored |
| expires_at | timestamptz | |
| created_at | timestamptz | |

#### user_providers

Links a user account to one or more Firebase social providers. A user who signs in with both Google and Apple has two rows here pointing to the same `user_id`.

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer FK → users.id CASCADE DELETE | |
| provider | varchar(50) NOT NULL | `google.com`, `facebook.com`, or `apple.com` |
| provider_uid | varchar(256) NOT NULL | Firebase UID for this provider |
| created_at | timestamptz | |

Unique index on `(provider, provider_uid)` — prevents the same social account being linked to two different users.

#### user_subscriptions

One row per user. Created synchronously at account creation — every new user starts on a 90-day Kinkane Plus trial. The effective tier is computed at read time using `getEffectiveTier()` — no cron job is needed to downgrade expired trials.

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer UNIQUE FK → users.id CASCADE DELETE | |
| tier | enum `free \| plus` | DB-level tier. Defaults to `free` |
| status | enum `active \| trialing \| cancelled` | New signups start as `trialing` |
| trial_ends_at | timestamptz | `NOW() + 90 days` on signup. Null on non-trial plans |
| stripe_customer_id | varchar(256) | Nullable — populated when Stripe is integrated |
| stripe_subscription_id | varchar(256) | Nullable — populated when Stripe is integrated |
| created_at / updated_at | timestamptz | |

**Effective tier rule:** if `status = 'trialing'` and `trial_ends_at < NOW()`, the user is treated as `free` — no DB write needed. Call `getEffectiveTier(subscription)` wherever tier-gating is required.

**Free tier limit:** Free users can save a maximum of **5 books** to their reading list. Check `user_books` count before any insert and reject with 403 if the user is on the free tier and already has 5 books.

---

#### recommendation_cache

Caches recommendation results for 48 hours to avoid redundant Gemini API calls. Keyed on a SHA-256 hash of the user's preferences (excluding their name).

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| input_hash | varchar(64) UNIQUE NOT NULL | SHA-256 of sorted preferences |
| results | jsonb NOT NULL | `[{ bookId, rank, explanation }]` |
| created_at | timestamptz | |
| expires_at | timestamptz NOT NULL | created_at + 48 hours |

#### guest_sessions

Temporary record created at recommendation time. Lives for `GUEST_SESSION_TTL_HOURS` (default 72 hours). Migrated to user tables on account creation, or deleted by the cleanup cron if the user never registers.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | `gen_random_uuid()` — returned to client as `guestSessionId` |
| display_name | varchar(200) NOT NULL | Name entered during onboarding |
| feelings | jsonb NOT NULL | `string[3]` |
| book_ids | jsonb NOT NULL | `number[]` — books they said they enjoyed (up to 10) |
| genres | jsonb NOT NULL | `string[3]` |
| dislikes | jsonb NOT NULL | `{ emotionalTone?, pacingStructure?, writingStyle?, genreFocus?, commitmentLevel? }` |
| chosen_book_ids | jsonb | `number[]` — 5 books chosen from recommendations. Null until `POST /:id/selections` is called |
| recommendation_hash | varchar(64) | Links back to `recommendation_cache.input_hash` |
| created_at | timestamptz | |
| expires_at | timestamptz NOT NULL | created_at + GUEST_SESSION_TTL_HOURS |

#### user_preferences

Migrated from `guest_sessions` when the user creates an account. One row per user.

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer UNIQUE FK → users.id CASCADE DELETE | |
| feelings | jsonb NOT NULL | |
| book_ids | jsonb NOT NULL | Books they enjoyed during onboarding |
| genres | jsonb NOT NULL | |
| dislikes | jsonb NOT NULL | |
| updated_at | timestamptz | |

#### user_interactions

Behavioural signals for future recommendation tuning. Seeded at registration from the 5 chosen onboarding books, then grows as the user browses, purchases, and rates books.

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer FK → users.id CASCADE DELETE | |
| book_id | integer FK → books.id CASCADE DELETE | |
| type | varchar(50) NOT NULL | `view`, `purchase`, `high_rating`, `wishlist`, `chosen_from_recommendation` |
| weight | real NOT NULL | Default `1.0` — higher = stronger signal |
| created_at | timestamptz | |

#### user_books

The user's personal reading list. Seeded at registration with the 5 onboarding choices as `want_to_read`.

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer FK → users.id CASCADE DELETE | |
| book_id | integer FK → books.id CASCADE DELETE | |
| status | varchar(20) NOT NULL | `want_to_read`, `reading`, `read` |
| source | varchar(50) NOT NULL | `chosen_from_onboarding`, `manual`, `recommended` |
| note | text | Optional user note about the book (max 1000 chars) |
| note_is_public | boolean NOT NULL | Default false — when true, note is visible to all users |
| added_at | timestamptz | |

Unique index on `(user_id, book_id)` — a book can only appear once per reading list.

#### password_reset_tokens

One row per in-flight password reset request. The raw token is never stored — only its SHA-256 hex hash. Deleted on use, and replaced when a new reset is requested (one active token per user at a time).

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| user_id | integer FK → users.id CASCADE DELETE | |
| token_hash | varchar(64) UNIQUE NOT NULL | SHA-256 hex of the raw token sent to the client |
| expires_at | timestamptz NOT NULL | 1 hour from creation |
| created_at | timestamptz | |

### Tables read from (owned by onix_ingester)

`books`, `book_contributors`, `book_subjects`, `book_genres`, `book_prices`, `genres`

See [onix_ingester README](../onix_ingester/README.md) for full schema documentation.

### Running migrations

```bash
npm run db:migrate
```

Safe to run on every deploy — Drizzle tracks applied migrations. To generate a new migration after editing a schema file:

```bash
npm run db:generate   # creates a new SQL file in drizzle/
npm run db:migrate    # applies it
```

---

## API Reference

Base URL: `https://your-service.onrender.com`

All `/api/v1/` routes return JSON. Errors follow the shape `{ "error": "..." }` or `{ "error": { "field": ["message"] } }` for validation failures.

---

### Health

#### `GET /api/health`

No auth. No rate limit.

```json
{ "status": "ok", "service": "kinkane-server" }
```

---

### Auth

#### `POST /api/v1/auth/signup`

Creates a new email/password account. `guestSessionId` is **required** — the user must complete the onboarding quiz before registering. A 90-day Kinkane Plus trial is started synchronously before tokens are returned. Guest session data (preferences, reading list, interaction signals) is migrated to the new account in the background.

**Body**
```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "password": "min8characters",
  "guestSessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Response `201`**
```json
{
  "user": {
    "id": 1,
    "name": "Jane Smith",
    "email": "jane@example.com",
    "emailVerified": false
  },
  "accessToken": "<jwt>",
  "refreshToken": "<opaque-token>"
}
```

**Errors**
- `400` — validation failure (missing guestSessionId, password too short, invalid email, etc.)
- `409` — email already registered

---

#### `POST /api/v1/auth/login`

**Body**
```json
{
  "email": "jane@example.com",
  "password": "yourpassword"
}
```

**Response `200`** — same shape as signup.

**Errors**
- `401` — invalid email or password (deliberately vague — no account enumeration)

---

#### `POST /api/v1/auth/refresh`

Exchanges a valid refresh token for a new access token and a **rotated refresh token**. The submitted token is deleted immediately — store the new `refreshToken` from the response. Each token can only be used once.

**Body**
```json
{ "refreshToken": "<opaque-token>" }
```

**Response `200`**
```json
{
  "accessToken": "<new-jwt>",
  "refreshToken": "<new-opaque-token>"
}
```

**Errors**
- `401` — token not found or expired

---

#### `POST /api/v1/auth/logout`

Deletes the refresh token from the database. The access token expires naturally (15 min).

**Body**
```json
{ "refreshToken": "<opaque-token>" }
```

**Response `200`**
```json
{ "message": "Logged out successfully" }
```

---

#### `POST /api/v1/auth/social`

Sign in or register using a Firebase ID token. If no account exists for this provider identity, one is created automatically. If an account with the same email already exists, the social provider is linked to it.

`guestSessionId` is **required**. For new accounts it triggers onboarding migration and starts a 90-day Plus trial. For returning users the field is validated but migration is skipped. Embed the `guestSessionId` in the Firebase OAuth `customParameters` state so it survives the provider redirect.

**Body**
```json
{
  "idToken": "<firebase-id-token>",
  "guestSessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Response `201` (new account) / `200` (returning user)**
```json
{
  "user": {
    "id": 1,
    "name": "Jane Smith",
    "email": "jane@example.com",
    "emailVerified": true
  },
  "accessToken": "<jwt>",
  "refreshToken": "<opaque-token>"
}
```

**Errors**
- `400` — missing or invalid guestSessionId
- `401` — Firebase rejected the token
- `422` — social account has no email address

**Mobile note:** Send the Firebase ID token, not the Google/Facebook/Apple access token. Obtain it with `firebaseUser.getIdToken()` after a successful Firebase sign-in.

---

#### `POST /api/v1/auth/forgot-password`

Sends a password reset link to the given email address. Always returns `200` regardless of whether the email is registered — this prevents account enumeration. The reset link expires in **1 hour**.

**Body**
```json
{ "email": "jane@example.com" }
```

**Response `200`**
```json
{ "message": "If that email is registered, a reset link has been sent" }
```

**Errors**
- `400` — invalid email format
- `429` — rate limit exceeded (5 requests per hour)

---

#### `POST /api/v1/auth/reset-password`

Validates the reset token and updates the user's password. The token is single-use — it is deleted on success. All active sessions (refresh tokens) are invalidated, forcing the user to log in again on all devices.

**Body**
```json
{
  "token": "<raw-token-from-email-link>",
  "password": "NewPassword123!"
}
```

Password must be at least 8 characters and contain at least one uppercase letter, one lowercase letter, one number, and one special character.

**Response `200`**
```json
{ "message": "Password updated successfully. Please log in again." }
```

**Errors**
- `400` — invalid or expired token, or password fails validation
- `429` — rate limit exceeded (5 requests per hour)

---

#### `GET /api/v1/auth/me`

Returns the full profile of the currently authenticated user including their subscription status and linked social providers.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Response `200`**
```json
{
  "user": {
    "id": 1,
    "name": "Jane Smith",
    "email": "jane@example.com",
    "emailVerified": true,
    "photoUrl": null,
    "subscription": {
      "tier": "plus",
      "status": "trialing",
      "effectiveTier": "plus",
      "trialEndsAt": "2026-08-29T00:00:00.000Z"
    },
    "providers": ["google.com"]
  }
}
```

- `effectiveTier` is the computed tier — always use this to gate features, not `tier` directly. A trialing user with an expired `trialEndsAt` will have `effectiveTier: "free"` even if `tier` is `"plus"`.
- `providers` is an empty array for email/password-only accounts.

**Errors**
- `401` — missing, malformed, or expired access token
- `404` — user not found

---

#### `POST /api/v1/auth/change-password`

Allows an authenticated user to change their password by verifying their current password first. Social-only accounts (no password set) receive a `400`. Other active sessions are **not** invalidated — only the password is updated.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Body**
```json
{
  "currentPassword": "OldPassword123!",
  "newPassword": "NewPassword456!"
}
```

Password rules apply to `newPassword` (min 8 chars, uppercase, lowercase, number, special character).

**Response `200`**
```json
{ "message": "Password updated successfully" }
```

A security notification email is sent to the user after a successful change.

**Errors**
- `400` — validation failure or social-only account
- `401` — current password incorrect

---

#### `DELETE /api/v1/auth/account`

Permanently deletes the authenticated user's account and all associated data — reading list, preferences, interactions, subscription, and linked social providers. A goodbye email is sent after deletion. The client should discard the access token on receipt of `200`.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Body**
```json
{ "password": "YourPassword123!" }
```

**Response `200`**
```json
{ "message": "Account deleted successfully" }
```

**Errors**
- `400` — missing password or social-only account
- `401` — incorrect password

---

### Books

All book endpoints are **public** — no auth required.

#### `GET /api/v1/books/search`

Typeahead suggestions. Designed to be called on every keystroke. Returns up to 15 results. Minimum 2 characters.

**Query parameters**

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | The text being typed. Min 2, max 100 chars |
| `limit` | number | Max suggestions. 1–15, default `8` |

**Response `200`**
```json
{
  "suggestions": [
    {
      "id": 42,
      "title": "Harry Potter and the Philosopher's Stone",
      "subtitle": null,
      "isbn13": "9781234567890",
      "productForm": "BC",
      "coverUrl": "https://...",
      "authors": ["J.K. Rowling"]
    }
  ]
}
```

Results ranked: title-starts-with → word-starts-with → trigram similarity > 0.3.

---

#### `GET /api/v1/books`

Paginated book list with optional filters and full-text search.

**Query parameters**

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Full text search |
| `genre` | string | Genre slug |
| `availability` | string | ONIX availability code e.g. `20` |
| `productForm` | string | ONIX product form e.g. `BB`, `BC`, `ED` |
| `publishingStatus` | string | ONIX publishing status e.g. `04` |
| `publisher` | string | Partial match on publisher name |
| `limit` | number | 1–50, default `20` |
| `offset` | number | Default `0` |

**Response `200`**
```json
{
  "books": [ { "id": 42, "title": "...", "contributors": [], "genres": [], "prices": [] } ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

#### `GET /api/v1/books/:id`

Full book detail including descriptions, subjects, and physical dimensions.

**Response `200`**
```json
{
  "book": {
    "id": 42,
    "isbn13": "9781234567890",
    "title": "Harry Potter and the Philosopher's Stone",
    "shortDescription": "The book that started it all.",
    "longDescription": "Harry Potter has never even heard of Hogwarts...",
    "pageCount": 223,
    "contributors": [ { "role": "A01", "personName": "J.K. Rowling", "sequenceNumber": 1 } ],
    "genres": [ { "name": "Children's fiction", "slug": "childrens_fiction" } ],
    "prices": [ { "priceType": "02", "priceAmount": "9.99", "currencyCode": "GBP" } ],
    "subjects": [ { "schemeIdentifier": "93", "subjectCode": "YFB", "subjectHeadingText": "Children's fiction", "isMainSubject": true } ]
  }
}
```

**Errors**
- `400` — ID is not a valid integer
- `404` — book not found

---

### Recommendations

#### `POST /api/v1/recommendations`

The core of the onboarding flow. Generates a ranked list of up to 250 book recommendations personalised to the user's preferences using pgvector similarity search, then adds a short explanation per book via Gemini. Also creates a guest session and returns its ID alongside the results.

Results are cached for 48 hours — identical preferences (regardless of name) return instantly from cache. A fresh guest session is always created.

**Body**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `displayName` | string | Yes | The name entered in step 1 of onboarding. Max 200 chars |
| `feelings` | string[3] | Yes | Exactly 3. Preset labels or freeform text (max 200 chars each) |
| `bookIds` | number[] | No | IDs of books they've enjoyed. Max 10. Default `[]` |
| `genres` | string[3] | Yes | Exactly 3 from the genre enum |
| `dislikes` | object | No | Reading experiences to avoid — all sub-arrays optional |

**Dislikes object**

```json
{
  "emotionalTone":    ["too dark or heavy", "sad or tragic ending", "emotionally intense"],
  "pacingStructure":  ["slow paced", "complex or layered plot", "multiple POVs"],
  "writingStyle":     ["academic or dense", "experimental writing style"],
  "genreFocus":       ["romance-heavy", "fantasy-heavy", "faith-based themes"],
  "commitmentLevel":  ["long book (500+ pages)", "series commitment"]
}
```

`commitmentLevel` dislikes apply hard SQL filters before the similarity search. The others are factored into the preference embedding.

**Valid genre values**

`literary fiction`, `poetry`, `self-help`, `mystery`, `romance`, `business`, `horror`, `sci-fi`, `historical fiction`, `biography`, `fantasy`, `non-fiction`, `society & education`, `sport`, `crime`, `young adult`, `classics`, `graphic novel`, `politics`, `health & lifestyle`, `travel`

**Example**
```bash
curl -X POST http://localhost:3000/api/v1/recommendations \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "Jason",
    "feelings": ["inspired", "relaxed", "thoughtful"],
    "bookIds": [1, 4, 17],
    "genres": ["literary fiction", "biography", "self-help"],
    "dislikes": {
      "emotionalTone": ["too dark or heavy"],
      "commitmentLevel": ["long book (500+ pages)", "series commitment"]
    }
  }'
```

**Response `200`**
```json
{
  "recommendations": [
    {
      "bookId": 42,
      "rank": 1,
      "explanation": "A quiet memoir matching your love of biography and need to feel inspired."
    },
    {
      "bookId": 7,
      "rank": 2,
      "explanation": "Short literary essays perfect for relaxed, reflective reading."
    }
  ],
  "guestSessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "expiresAt": "2026-05-26T14:32:00.000Z"
}
```

The client should store `guestSessionId` immediately — it is needed for the next two steps.

**Errors**
- `400` — validation failure (wrong number of feelings/genres, invalid genre value, etc.)
- `429` — rate limit exceeded (20 requests per hour per IP)

---

### Guest Sessions

#### `POST /api/v1/guest-sessions/:id/selections`

Saves the 5 books the user chose from the recommendations screen. Must be called after `POST /recommendations` and before the user registers.

**Params**
- `id` — the `guestSessionId` returned by `POST /recommendations`

**Body**
```json
{ "chosenBookIds": [42, 7, 103, 56, 88] }
```

| Field | Type | Notes |
|-------|------|-------|
| `chosenBookIds` | number[] | 1–5 book IDs from the recommendation results |

**Response `200`**
```json
{ "ok": true }
```

**Errors**
- `400` — invalid UUID or validation failure
- `404` — session not found or expired

---

#### `GET /api/v1/guest-sessions/:id`

Checks whether a stored `guestSessionId` is still alive. Useful on app resume to decide whether to prompt the user to re-do the flow or proceed to registration.

**Response `200`**
```json
{
  "guestSessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "displayName": "Jason",
  "expiresAt": "2026-05-26T14:32:00.000Z"
}
```

**Errors**
- `400` — invalid UUID format
- `404` — session not found or expired

---

### User Books

All user book endpoints require a valid Bearer token.

#### `POST /api/v1/user-books/reset`

Clears the user's entire reading list after verifying their password. Irreversible.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Body**
```json
{ "password": "YourPassword123!" }
```

**Response `200`**
```json
{ "deleted": 12 }
```

**Errors**
- `400` — missing password or social-only account
- `401` — incorrect password

---

### User Settings

All user settings endpoints require a valid Bearer token.

#### `GET /api/v1/user/settings`

Returns all settings for the authenticated user.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Response `200`**
```json
{
  "settings": {
    "shelfVisibility": "private"
  }
}
```

**Errors**
- `401` — unauthenticated
- `404` — user not found

---

#### `PATCH /api/v1/user/settings/shelf-visibility`

Controls who can view the user's reading list.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Body**
```json
{ "visibility": "public" }
```

| Value | Who can see the shelf |
|-------|-----------------------|
| `public` | All Kinkane users |
| `friends` | Mutual friends/followers only |
| `private` | Only the user themselves (default) |

**Response `200`**
```json
{ "shelfVisibility": "public" }
```

**Errors**
- `400` — invalid visibility value
- `401` — unauthenticated

---

## Subscriptions

Every user starts on a **90-day Kinkane Plus trial** created synchronously at account creation. After the trial period, their effective tier becomes **Free** — no cron job or DB write is needed.

### Tiers

| Tier | How obtained | Bookshelf limit | Features |
|------|-------------|-----------------|----------|
| **Free** | Default after trial expires | **5 books max** | Quiz, recommendations, basic bookshelf, community browsing, trending content |
| **Kinkane Plus** | Trial (90 days) or paid subscription | Unlimited | Everything in Free + memory across sessions, smarter recommendations, reading identity profile, Kin Reads, expanded history, enhanced community features |

### Trial lifecycle

```
Signup
  → user_subscriptions: { tier: 'plus', status: 'trialing', trial_ends_at: NOW() + 90 days }

During trial
  → getEffectiveTier() returns 'plus'

After trial_ends_at
  → getEffectiveTier() returns 'free'  ← no DB write required, computed at read time

User pays
  → tier updated to 'plus', status to 'active', trial_ends_at cleared
  → stripe_customer_id / stripe_subscription_id populated
```

### Checking a user's tier

Use `getEffectiveTier(subscription)` from `src/db/schema/subscriptions.ts` anywhere tier-gating is required. It takes the `user_subscriptions` row and returns `'free'` or `'plus'`.

### Free tier bookshelf cap

Before inserting into `user_books`, check the count of existing rows for that user. If count ≥ 5 and `getEffectiveTier()` returns `'free'`, reject with **403 Forbidden**. The onboarding migration seeds at most 5 books (enforced by the selections endpoint), so newly registered free users start exactly at the limit.

### Stripe integration

`stripe_customer_id` and `stripe_subscription_id` columns are present but nullable. Wire them up when adding Stripe webhooks to handle payment confirmation, cancellation, and renewal.

---

## Rate Limiting

Rate limits are applied per IP address. Exceeding a limit returns `429 Too Many Requests`.

| Route | Limit | Window | Reason |
|-------|-------|--------|--------|
| `POST /auth/signup` | 10 | 1 hour | Prevents mass account creation |
| `POST /auth/login` | 20 | 15 min | Brute-force protection |
| `POST /auth/social` | 20 | 15 min | Same risk profile as login |
| `POST /auth/refresh` | 60 | 15 min | Apps refresh silently on every token expiry |
| `POST /auth/forgot-password` | 5 | 1 hour | Prevents email bombing and token brute-forcing |
| `POST /auth/reset-password` | 5 | 1 hour | Same window as forgot-password |
| `POST /recommendations` | 20 | 1 hour | Each uncached request calls Gemini API (real cost) |
| All other `/v1/` routes | 300 | 15 min | Comfortable for active browsing |
| `GET /health` | None | — | Uptime checkers must not be blocked |

Response headers on every rate-limited route:
- `RateLimit-Limit` — the cap for this window
- `RateLimit-Remaining` — requests left in current window
- `RateLimit-Reset` — Unix timestamp when the window resets

---

## Search Behaviour

When `q` is provided on `GET /api/v1/books`:

1. **Full text search** — uses the `search_vector` tsvector column maintained by a database trigger. Runs `plainto_tsquery('english', q)`. Results ranked by `ts_rank`.

2. **Trigram fallback** — if FTS returns zero results, a second query runs using `pg_trgm` similarity on the title column. Catches typos (e.g. `"Filosopher Stone"` still finds the right book).

3. **Filter combination** — `q` combines with all other filter params. Searching `q=rowling&genre=childrens_fiction` returns only books matching both.

---

## Background Jobs

### Guest session cleanup

A `node-cron` job runs inside the server process every 6 hours:

```
Cron: 0 */6 * * *
Task: DELETE FROM guest_sessions WHERE expires_at < NOW()
```

Logs the number of deleted rows at `info` level. Errors are caught and logged without crashing the server. The cleanup interval is fixed at 6 hours; the session lifetime itself is controlled by `GUEST_SESSION_TTL_HOURS`.

---

### Email queue

All outgoing emails are processed through a **BullMQ** queue backed by Redis. Emails are never sent directly from the HTTP request path — the service layer enqueues a job and returns immediately. A worker running inside the same process picks it up asynchronously.

**Why a queue instead of direct sends?**
- Automatic retries with exponential backoff (3 attempts, 2s → 4s)
- Survives transient SendGrid outages without losing emails
- Controlled concurrency (5 simultaneous sends) respects SendGrid rate limits
- Priority lanes ensure password reset emails jump ahead of bulk newsletter jobs
- Full job history visible in Bull Board

**Job priorities** (lower = higher priority):

| Job type | Priority |
|----------|----------|
| `password-reset` | 1 — user is blocked without this |
| `password-changed` | 1 — security notification |
| `account-deleted` | 1 — security notification |
| `welcome` | 5 |
| `trial-ending` | 5 |
| `new-recommendation` | 7 |
| `weekly-digest` | 8 |
| `newsletter` | 10 — bulk, can wait |

**Retry policy:** 3 attempts with exponential backoff (2s, 4s). After all attempts are exhausted the job moves to `failed` state and is retained in Redis for inspection via Bull Board.

**Bull Board** — a visual dashboard for the email queue — is available at `/admin/queues`. It shows all pending, active, completed, and failed jobs with full payloads and error details.

> **Important:** Protect `/admin/queues` with authentication before going to production.

**Graceful shutdown:** On `SIGTERM`/`SIGINT` the worker finishes its currently active job before closing, ensuring no email is dropped mid-send.

---

### Weekly digest

A `node-cron` job fires every Monday at **08:00 UTC** and enqueues a `weekly-digest` job for each active user. The worker processes them in batches of 5 (controlled by the worker's `concurrency` setting).

```
Cron: 0 8 * * 1  (Mondays at 08:00 UTC)
Task: enqueueEmail('weekly-digest', { to, payload }) per active user
```

> The query to fetch active users and build each digest payload is not yet implemented — the cron stub is in place and ready to be wired up once the user activity data layer is built.

---

## Email

All emails are sent via **SendGrid** and routed through the BullMQ queue. Email templates live in `src/emails/` organised by type.

### Email types

| Type | File | Trigger |
|------|------|---------|
| Welcome | `transactional/welcome.ts` | New account created (email/password or social) |
| Password reset | `transactional/password-reset.ts` | `POST /auth/forgot-password` |
| Password changed | `transactional/password-changed.ts` | `POST /auth/change-password` |
| Account deleted | `transactional/account-deleted.ts` | `DELETE /auth/account` |
| Trial ending | `notifications/trial-ending.ts` | Manually enqueued when trial nears expiry |
| New recommendation | `notifications/new-recommendation.ts` | Manually enqueued after recommendation generation |
| Newsletter | `marketing/newsletter.ts` | Manually enqueued per campaign |
| Weekly digest | `reports/weekly-digest.ts` | Monday 08:00 UTC cron |

### Sending an email from code

Always enqueue via the helper — never call `sendXxxEmail()` directly from a service:

```ts
import { enqueueEmail } from '../lib/email-queue';

await enqueueEmail('welcome', { to: user.email, name: user.name });
await enqueueEmail('trial-ending', { to: user.email, name: user.name, daysLeft: 7 });
```

The helper is fully typed — TypeScript will catch mismatched payloads at compile time.

### SendGrid setup

1. Create an account at [sendgrid.com](https://sendgrid.com)
2. Go to **Settings → API Keys** and create a key with **Mail Send** permission
3. Verify your sender domain or email address under **Settings → Sender Authentication**
4. Add `SENDGRID_API_KEY` and `EMAIL_FROM` to your `.env`

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Fill in DATABASE_URL, REDIS_URL, JWT secrets, Firebase credentials,
# GEMINI_API_KEY, SENDGRID_API_KEY, and APP_URL

# 3. Apply migrations
npm run db:migrate

# 4. Start with hot reload
npm run dev
```

The server requires:
- **PostgreSQL** with the book tables already created by `onix_ingester`. If running without the ingester, run the ingester's `db:init` first, or manually apply its migrations against the same database.
- **Redis** running locally (`redis://localhost:6379` by default). Used for rate limiting and the email job queue.

Once running, the **Bull Board** queue dashboard is available at `http://localhost:3000/admin/queues`.

---

## Deploying to Render

`render.yaml` defines the web service configuration. The service connects to the same PostgreSQL instance as `onix_ingester` via `DATABASE_URL`.

### Environment variables on Render

Set all values from [Environment Variables](#environment-variables) in the Render dashboard. `DATABASE_URL` is injected automatically from the linked database. `REDIS_URL` is injected automatically from the linked Redis instance. Set `SENDGRID_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, and `APP_URL` manually.

### Pre-deploy command

```bash
npm run db:migrate
```

Runs on every deploy before the new instance starts. Idempotent and safe.

### Build and start

```
Build:  npm install && npm run build
Start:  node dist/server.js
```

---

## Firebase Setup

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project
2. Go to **Authentication → Sign-in method** and enable the providers you need: Google, Facebook, Apple

### 2. Generate a service account key

1. Go to **Project Settings → Service accounts**
2. Click **Generate new private key** — downloads a JSON file
3. Copy these three values into your `.env`:

```
FIREBASE_PROJECT_ID      ← "project_id"
FIREBASE_CLIENT_EMAIL    ← "client_email"
FIREBASE_PRIVATE_KEY     ← "private_key"
```

Keep the private key wrapped in double quotes and leave the `\n` characters as-is.

### 3. Mobile integration

The mobile app initialises Firebase and calls the appropriate sign-in method per provider. After a successful sign-in, call `firebaseUser.getIdToken()` and POST that string to `POST /api/v1/auth/social`.

For the onboarding flow, the `guestSessionId` must survive the OAuth redirect. Embed it in the Firebase `customParameters` state parameter before initiating the provider sign-in, then read it back from state in the OAuth callback and include it in the `POST /auth/social` request body.

### 4. Facebook & Apple extra steps

- **Facebook** — requires a Facebook App ID and secret entered into Firebase's Facebook provider settings
- **Apple** — requires an Apple Developer account. Apple sign-in is mandatory on iOS if your app offers any other social login option (App Store guideline 4.8)

### Service account security

- Never commit the service account JSON or your `.env` to version control
- On Render, set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` as environment variables in the dashboard
