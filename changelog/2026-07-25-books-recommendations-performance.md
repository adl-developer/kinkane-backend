# Stop book browsing and recommendations from loading slowly

**Date:** 2026-07-25

## What changed

`GET /api/v1/books` (plain browsing, no search query) and the recommendation
endpoints (`GET /books/:id/similar`, and `personalized()` used by the
personalized feed) were both running expensive, uncached full-table queries
on every request. Fixed the underlying queries and added caching so they
scale with the size of the catalogue instead of degrading as it grows.

**Book listing** ([books.service.ts](../src/services/books.service.ts)):
- `list()` now caches its result in Redis (5 min TTL, keyed by a hash of the
  query params) — every other book-serving endpoint in this file already did
  this; `list()` was the one exception, hitting Postgres on every call.
- Added `idx_books_updated_at`
  ([books.ts](../src/db/schema/books.ts),
  [0025_books_updated_at_index.sql](../drizzle/0025_books_updated_at_index.sql))
  so the default (no `q`/`sort`) `ORDER BY updated_at LIMIT/OFFSET` doesn't
  force a full-table sort on a cache miss.

**Recommendations** ([books.service.ts](../src/services/books.service.ts),
[setup.ts](../src/db/setup.ts)):
- Added an HNSW index (`vector_cosine_ops`) on `books.embedding`. Without it,
  `similar()` and `personalized()`'s `ORDER BY embedding <=> vector` queries
  were brute-force scanning every embedded row and computing 768-dimension
  cosine distance for each one, on every cache miss.
- Both queries now run inside a transaction with `SET LOCAL hnsw.ef_search =
  150` — HNSW's default `ef_search` (40) is lower than the candidate pool
  sizes these queries request (up to 100), which would silently reduce match
  quality. `SET LOCAL` (not a bare `SET`) so the change is scoped to that one
  transaction and doesn't leak onto the pooled connection for unrelated
  queries afterward.
- `personalized()` was fetching the user's preference embedding, then
  separately fetching their shelf (to exclude owned books) — two sequential
  round trips for two independent queries. Parallelized with `Promise.all`.

**Author search** (`GET /books/search?type=author`, `authorSuggestions`):
found the same gap while in this code — title search has a trigram index
(`idx_books_title_trgm`) backing its `ILIKE`/`word_similarity` matching, but
the identical query shape against `book_contributors.person_name` had no
equivalent index. Added `idx_book_contributors_person_name_trgm`.

## Why

All of the above is the same underlying pattern: a query whose cost scales
with total table size, running uncached on a table that's continuously
growing via the Gardners ONIX ingestion pipeline (see `onix_ingester`). As
the catalogue grows, these endpoints would keep getting slower rather than
staying flat — the fix is indexing the query shape that's actually run, and
caching so repeat requests don't pay full cost every time.

## Non-obvious decisions

- **HNSW over ivfflat** for the vector index: ivfflat needs its `lists`
  parameter re-tuned as the table grows to stay accurate; HNSW doesn't need
  that maintenance, which matters here given the catalogue's continuous
  growth from Gardners ingestion.
- **HNSW is approximate**, not exact — `similar`/`personalized` results can
  differ very slightly from a brute-force nearest-neighbor scan. This is the
  standard, expected tradeoff for recommendations at this scale (raised
  `ef_search` keeps recall high) and is not applied anywhere accuracy must be
  exact — the listing endpoint's `COUNT(*)` was left as an exact count
  rather than switched to an estimate, so pagination totals stay correct.
- **Left `books.is_removed` filtering alone.** Investigating this code
  surfaced that withdrawn books still appear in every listing/search/
  recommendation surface, same as before — see
  [2026-07-16-books-soft-delete.md](2026-07-16-books-soft-delete.md), which
  already flagged this as an intentional, undecided product question rather
  than a bug. Out of scope for a performance pass.

## What's explicitly out of scope

- No changes to `trending()` — it's already cached (not per-user) and backed
  by a real composite index (`idx_user_interactions_trending`), so it wasn't
  part of the problem.
- No new automated tests — this repo has no integration test harness against
  a real Postgres/Redis instance for the services layer (existing tests only
  cover pure functions like `dedupe.ts`), so verification here was
  type-checking plus manual review of the query plans these changes target.
  Applying the new indexes requires a real deploy (they ship via the existing
  `db:init` predeploy step) to verify against live data.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- `npm run db:generate` produced a single-statement migration for the new
  `updated_at` index; reviewed by hand.
- No live database was touched — the HNSW/trigram indexes in `setup.ts` and
  the new migration haven't been applied anywhere yet; they take effect on
  the next deploy via `render.yaml`'s `preDeployCommand: npm run db:init`.
  Worth confirming the deployed Postgres's pgvector version supports HNSW
  (`>= 0.5.0`) before/during that deploy.
