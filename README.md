# Kinkane Server

The main API for the Kinkane book platform. Serves book catalogue data, handles user authentication, and is designed to grow into the full consumer-facing backend.

This is one of two independent services that share the same PostgreSQL database:

| Service | Responsibility |
|---------|---------------|
| **kinkane-server** (this) | Serves books to clients, manages users and auth |
| **onix-ingester** | Ingests ONIX 3.1 XML feeds from Cloudflare R2 into PostgreSQL |

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Setup](#project-setup)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [API Reference](#api-reference)
  - [Health](#health)
  - [Auth](#auth)
  - [Books](#books)
- [Rate Limiting](#rate-limiting)
- [Search Behaviour](#search-behaviour)
- [Running Locally](#running-locally)
- [Deploying to Render](#deploying-to-render)
- [Firebase Setup](#firebase-setup)

---

## Prerequisites

| Requirement | Minimum version | Notes |
|-------------|----------------|-------|
| Node.js | 20+ | Node 22 recommended |
| npm | 9+ | Bundled with Node |
| PostgreSQL | 14+ | Must have `pg_trgm` extension enabled (handled by `onix_ingester`) |

No Redis required — this service is stateless aside from the database.

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

This creates the `users` and `refresh_tokens` tables. The book-related tables are owned by `onix_ingester` — this service only reads from them.

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
| `npm run db:reset` | Drop all tables, types, and migration records — run `db:migrate` after to start fresh |

---

## Architecture

### Two apps, one database

Both `kinkane-server` and `onix_ingester` point to the same `DATABASE_URL`. They manage separate tables:

- `onix_ingester` owns: `books`, `book_contributors`, `book_subjects`, `book_genres`, `book_prices`, `genres`
- `kinkane-server` owns: `users`, `refresh_tokens`, `user_providers`, `ingestion_jobs`, `ingestion_chunks`

The server defines read-only Drizzle schema representations of the book tables so it can query them without owning their migrations. This is clearly marked in `src/db/schema/books.ts`.

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
  ← { accessToken }   (refresh token valid for 30 days)

POST /api/v1/auth/logout  { refreshToken }
  → refresh token deleted from DB, immediately invalidated
```

Refresh tokens are stored in PostgreSQL as a SHA-256 hash — the raw token is only ever held by the client. This means logout is real: the token cannot be used again even if intercepted.

### Route versioning

All routes are versioned under `/api/v1/`. Adding a v2 means creating a new router and mounting it at `/v2` in `src/routes/index.ts` — nothing else changes.

```
/api/health          — unversioned, no rate limit (uptime checks)
/api/v1/auth/...     — auth routes
/api/v1/books/...    — book routes
```

---

## Project Structure

```
server/
├── src/
│   ├── config/index.ts              # Env validation (zod), typed config
│   ├── db/
│   │   ├── index.ts                 # Drizzle client
│   │   ├── reset.ts                 # Drops all tables and types (dev utility)
│   │   └── schema/
│   │       ├── users.ts             # users, refresh_tokens, user_providers (owned by this service)
│   │       ├── books.ts             # Read-only book tables (owned by onix_ingester)
│   │       └── index.ts
│   ├── lib/
│   │   ├── firebase.ts              # Firebase Admin SDK initialisation
│   │   └── logger.ts                # Structured JSON logger
│   ├── services/
│   │   ├── auth.service.ts          # signup, login, refresh, logout, verifyAccessToken
│   │   └── books.service.ts         # list (FTS + trigram fallback), getById
│   ├── controllers/
│   │   ├── auth.controller.ts       # Input validation + delegates to auth.service
│   │   └── books.controller.ts      # Input validation + delegates to books.service
│   ├── middleware/
│   │   ├── auth.middleware.ts       # requireAuth — verifies Bearer JWT
│   │   └── rate-limit.middleware.ts # Per-route rate limiters
│   ├── routes/
│   │   ├── index.ts                 # Mounts /health + v1 router
│   │   ├── auth.routes.ts           # Auth route definitions
│   │   └── books.routes.ts          # Book route definitions
│   ├── app.ts                       # Express app, middleware, error handler
│   └── server.ts                    # Entry point, graceful shutdown
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
```

**Why two JWT secrets?** Access and refresh tokens are signed with different secrets. A leaked access token cannot be used to forge a refresh token.

**Firebase private key newlines:** The private key in service account JSON contains literal `\n` characters. When pasting into Render or a `.env` file, wrap the value in double quotes and keep the `\n` literals — the server unescapes them automatically at startup.

---

## Database

### Tables owned by this service

#### users

| Column | Type | Notes |
|--------|------|-------|
| id | serial PK | |
| full_name | varchar(500) NOT NULL | |
| email | varchar(500) UNIQUE NOT NULL | Stored lowercase |
| password_hash | varchar(500) | Nullable — NULL for social-only accounts |
| photo_url | varchar(1000) | Profile photo from social provider, if provided |
| email_verified | boolean | Default false; set true when provider confirms email |
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

### Tables read from (owned by onix_ingester)

`books`, `book_contributors`, `book_subjects`, `book_genres`, `book_prices`, `genres`

See [onix_ingester README](../onix_ingester/README.md) for full schema documentation.

### Running migrations

```bash
npm run db:migrate
```

Only runs migrations for tables this service owns (`users`, `refresh_tokens`, `user_providers`, `ingestion_jobs`, `ingestion_chunks`). Safe to run on every deploy — Drizzle tracks applied migrations.

To generate a new migration after editing a schema file:

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

Creates a new account. Returns the user and both tokens.

**Body**
```json
{
  "fullName": "Jane Smith",
  "email": "jane@example.com",
  "password": "min8characters"
}
```

**Response `201`**
```json
{
  "user": {
    "id": 1,
    "fullName": "Jane Smith",
    "email": "jane@example.com",
    "emailVerified": false
  },
  "accessToken": "<jwt>",
  "refreshToken": "<opaque-token>"
}
```

**Errors**
- `400` — validation failure (password too short, invalid email, etc.)
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

Exchange a valid refresh token for a new access token. Does not rotate the refresh token.

**Body**
```json
{ "refreshToken": "<opaque-token>" }
```

**Response `200`**
```json
{ "accessToken": "<new-jwt>" }
```

**Errors**
- `401` — token not found or expired

---

#### `POST /api/v1/auth/social`

Sign in or register using a Firebase ID token obtained by the mobile app after the user completes a Google, Facebook, or Apple sign-in. If no account exists for this provider identity, one is created automatically. If an account with the same email already exists (e.g. from a previous email/password signup), the social provider is linked to that existing account.

**Body**
```json
{ "idToken": "<firebase-id-token>" }
```

**Response `200`**
```json
{
  "user": {
    "id": 1,
    "fullName": "Jane Smith",
    "email": "jane@example.com",
    "emailVerified": true,
    "photoUrl": "https://lh3.googleusercontent.com/..."
  },
  "accessToken": "<jwt>",
  "refreshToken": "<opaque-token>"
}
```

**Errors**
- `400` — `idToken` missing or blank
- `401` — Firebase rejected the token (expired, malformed, wrong project)
- `401` — Provider identity has no email (required to create/match an account)

**Note for the mobile team:** send the Firebase ID token, not the Google/Facebook/Apple access token directly. Obtain it with `firebaseUser.getIdToken()` after a successful Firebase sign-in.

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

#### `GET /api/v1/auth/me`

Returns the currently authenticated user.

**Headers**
```
Authorization: Bearer <accessToken>
```

**Response `200`**
```json
{
  "user": {
    "id": 1,
    "email": "jane@example.com"
  }
}
```

**Errors**
- `401` — missing, malformed, or expired access token

---

### Books

Both book endpoints are **public** — no auth required.

#### `GET /api/v1/books/search`

Typeahead suggestions — designed to be called on every keystroke. Returns up to 15 ranked results as the user types. Minimum 2 characters.

**Query parameters**

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | The text being typed. Min 2, max 100 chars. |
| `limit` | number | Max suggestions to return. 1–15, default `8` |

**Example**
```
GET /api/v1/books/search?q=harr&limit=5
```

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
      "authors": ["J.K. Rowling"]
    },
    {
      "id": 43,
      "title": "Harry Potter and the Chamber of Secrets",
      "subtitle": null,
      "isbn13": "9781234567891",
      "productForm": "BC",
      "authors": ["J.K. Rowling"]
    }
  ]
}
```

Results are ranked in this order:
1. Titles that **start with** the typed text
2. Titles where **a word starts with** the typed text
3. Titles with **trigram similarity > 0.3** (catches typos)

Within each tier, results are further sorted by `word_similarity` score descending. Returns an empty array if fewer than 2 characters are provided.

---

#### `GET /api/v1/books`

Returns a paginated list of books with optional filters and search.

**Query parameters**

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Full text search. Plain words, no operators needed. |
| `genre` | string | Genre slug e.g. `fiction_crime_mystery` |
| `availability` | string | ONIX availability code e.g. `20` (Available) |
| `productForm` | string | ONIX product form code e.g. `BB` (Hardback), `BC` (Paperback), `ED` (Digital) |
| `publishingStatus` | string | ONIX publishing status code e.g. `04` (Active) |
| `publisher` | string | Partial match on publisher name |
| `limit` | number | Results per page. 1–50, default `20` |
| `offset` | number | Pagination offset, default `0` |

**Example**
```
GET /api/v1/books?q=harry+potter&availability=20&limit=10
```

**Response `200`**
```json
{
  "books": [
    {
      "id": 42,
      "isbn13": "9781234567890",
      "recordReference": "PUB-001",
      "title": "Harry Potter and the Philosopher's Stone",
      "subtitle": null,
      "publisherName": "Bloomsbury",
      "imprintName": null,
      "productForm": "BC",
      "publicationDate": "1997-06-26",
      "publishingStatus": "04",
      "availabilityCode": "20",
      "pageCount": 223,
      "contributors": [
        { "sequenceNumber": 1, "role": "A01", "personName": "J.K. Rowling" }
      ],
      "genres": [
        { "name": "Children's fiction", "slug": "childrens_fiction" }
      ],
      "prices": [
        { "priceType": "02", "priceAmount": "9.99", "currencyCode": "GBP" }
      ],
      "createdAt": "2026-05-01T10:00:00Z",
      "updatedAt": "2026-05-01T10:00:00Z"
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

---

#### `GET /api/v1/books/:id`

Returns full book detail including descriptions, all subjects, and physical dimensions.

**Example**
```
GET /api/v1/books/42
```

**Response `200`**
```json
{
  "book": {
    "id": 42,
    "isbn13": "9781234567890",
    "title": "Harry Potter and the Philosopher's Stone",
    "subtitle": null,
    "shortDescription": "The book that started it all.",
    "longDescription": "Harry Potter has never even heard of Hogwarts...",
    "publisherName": "Bloomsbury",
    "productForm": "BC",
    "publicationDate": "1997-06-26",
    "publishingStatus": "04",
    "availabilityCode": "20",
    "editionNumber": null,
    "pageCount": 223,
    "heightMm": "197.00",
    "widthMm": "129.00",
    "thicknessMm": "16.00",
    "weightGr": "245.00",
    "countryOfManufacture": "GB",
    "countryOfPublication": "GB",
    "returnsCode": null,
    "orderTime": null,
    "contributors": [
      { "sequenceNumber": 1, "role": "A01", "personName": "J.K. Rowling" }
    ],
    "genres": [
      { "name": "Children's fiction", "slug": "childrens_fiction" }
    ],
    "prices": [
      { "priceType": "02", "priceAmount": "9.99", "currencyCode": "GBP" }
    ],
    "subjects": [
      {
        "schemeIdentifier": "93",
        "subjectCode": "YFB",
        "subjectHeadingText": "Children's fiction",
        "isMainSubject": true
      }
    ],
    "createdAt": "2026-05-01T10:00:00Z",
    "updatedAt": "2026-05-01T10:00:00Z"
  }
}
```

**Errors**
- `400` — ID is not a valid integer
- `404` — book not found

---

## Rate Limiting

Rate limits are applied per IP address. Exceeding a limit returns `429 Too Many Requests`.

| Route | Limit | Window | Reason |
|-------|-------|--------|--------|
| `POST /auth/signup` | 10 | 1 hour | Prevents mass account creation |
| `POST /auth/login` | 20 | 15 min | Brute-force protection |
| `POST /auth/social` | 20 | 15 min | Same risk profile as login |
| `POST /auth/refresh` | 60 | 15 min | Apps refresh silently on every token expiry |
| All other `/v1/` routes | 300 | 15 min | Comfortable for active browsing |
| `GET /health` | None | — | Uptime checkers must not be blocked |

Response headers on every rate-limited route:
- `RateLimit-Limit` — the cap for this window
- `RateLimit-Remaining` — requests left in current window
- `RateLimit-Reset` — Unix timestamp when the window resets

---

## Search Behaviour

When `q` is provided on `GET /api/v1/books`:

1. **Full text search** — uses the `search_vector` tsvector column maintained by a database trigger on the books table. Runs `plainto_tsquery('english', q)` so users write plain words with no special syntax. Results are ranked by `ts_rank`.

2. **Trigram fallback** — if FTS returns zero results, a second query automatically runs using `pg_trgm` similarity on the title column. This catches typos and partial words (e.g. `"Filosopher Stone"` still finds the right book). Results are ranked by similarity score.

3. **Filter combination** — `q` combines with all other filter params in the same query. Searching for `q=rowling&genre=childrens_fiction` returns only books matching both.

---

## Deploying to Render

`render.yaml` defines the web service configuration. The service connects to the same PostgreSQL instance as `onix_ingester` via `DATABASE_URL`.

### Environment variables on Render

Set all values from [Environment Variables](#environment-variables) in the Render dashboard. `DATABASE_URL` is injected automatically from the linked database. `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are auto-generated by Render on first deploy.

### Pre-deploy command

```bash
npm run db:migrate
```

Runs on every deploy before the new instance starts. Only applies new migrations — idempotent and safe.

### Build and start

```
Build:  npm install && npm run build
Start:  node dist/server.js
```

---

## Firebase Setup

### 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project
2. In the project, go to **Authentication → Sign-in method** and enable the providers you need: Google, Facebook, Apple

### 2. Generate a service account key

1. Go to **Project Settings → Service accounts**
2. Click **Generate new private key** — this downloads a JSON file
3. From that JSON, copy these three values into your `.env`:

```
FIREBASE_PROJECT_ID      ← "project_id"
FIREBASE_CLIENT_EMAIL    ← "client_email"
FIREBASE_PRIVATE_KEY     ← "private_key"
```

Keep the private key wrapped in double quotes and leave the `\n` characters as-is — the server unescapes them at startup.

### 3. Enable providers on the mobile side

The mobile team initialises Firebase in the app and calls the appropriate sign-in method per provider. After a successful sign-in they call `firebaseUser.getIdToken()` and POST that string to `POST /api/v1/auth/social`. No further Firebase configuration is needed on the backend.

### 4. Facebook & Apple extra steps

- **Facebook** — requires a Facebook App ID and secret entered into Firebase's Facebook provider settings. The mobile team also needs the App ID.
- **Apple** — requires an Apple Developer account. Firebase's Apple sign-in docs walk through creating a Services ID and private key. Apple sign-in is mandatory on iOS if your app offers any other social login option (App Store guideline 4.8).

### Service account security

- Never commit the service account JSON or your `.env` to version control
- On Render, set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` as environment variables in the dashboard — they are injected at runtime and never touch the filesystem
