# Stop trending's fallback from scanning every book

**Date:** 2026-07-26

## What changed

Added `idx_books_publication_date` ([books.ts](../src/db/schema/books.ts),
migration [0026_huge_calypso.sql](../drizzle/0026_huge_calypso.sql)).

`booksService.trending()` falls back to recently-published books
(`ORDER BY publication_date DESC LIMIT poolSize`) whenever the last-30-days
interaction pool doesn't fill the requested size. With no supporting index,
`EXPLAIN (ANALYZE, BUFFERS)` showed this as a parallel sequential scan of the
full ~1.1M-row `books` table plus a full sort, at ~6.8s execution time.
`GET /api/v1/explore/trending` measured end-to-end at ~8.3s.

With the index in place, the same query plan is `Index Scan Backward using
idx_books_publication_date`, confirmed at **16.2ms execution**.

## Why

This was found while investigating a broader "any books endpoint gets slow"
report — the previous performance pass
([2026-07-25-books-recommendations-performance.md](2026-07-25-books-recommendations-performance.md))
covered `list()`'s default sort (`updated_at`, already indexed) and the
vector-search endpoints, but didn't touch this fallback path, which has no
supporting index at all.

## What's explicitly out of scope

- No change to when the fallback fires (still whenever the interaction pool
  doesn't fill `poolSize`) — only the query itself was fixed.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- Migration generated via `npm run db:generate` and applied to the live
  database via `npm run db:migrate`.
- Re-ran `EXPLAIN (ANALYZE, BUFFERS)` against the live database before and
  after applying the migration to confirm the plan and timing change
  directly, not just reasoned about.
