# Stop showing duplicate book titles in recommendations and feeds

**Date:** 2026-07-14

## What changed

Book recommendations, the trending list, the personalized "For You" feed,
and "similar books" could previously show the same title twice in one
response. This happens because each edition of a book (hardback vs
paperback, or a multi-volume set like a "Vol. 1"/"Vol. 2" pair) is stored as
its own row with its own ISBN — two rows can independently rank high enough
in a similarity/interaction search to both land in the same result list.

All four feeds now drop repeat titles, keeping only the best-ranked edition
of each title:

- `recommendationsService.getRecommendations()` / `computeRecommendations()`
  in `src/services/recommendations.service.ts`
- `booksService.trending()`, `.personalized()`, and `.similar()` in
  `src/services/books.service.ts`

## Non-obvious decisions

- **Over-fetch, dedupe, then slice** — each of these queries now pulls a
  candidate pool of `min(limit × 3, 100)` rows instead of exactly `limit`,
  dedupes by title, then slices back down to `limit`. Without the larger
  pool, dropping a duplicate would just shrink the result count below what
  the caller asked for. `recommendations.service.ts` already over-fetched
  (2000 candidates down to 100) for unrelated reasons, so it only needed the
  dedupe step; `books.service.ts`'s three feed functions previously fetched
  exactly `limit` rows and needed the pool size bumped too.
- **Title matching is exact after trim + lowercase** — not fuzzy. Live data
  checked during this change (e.g. "The Middle Way" Vol. 1/2, "A Care Crisis
  in the Nordic Welfare States?" hardback/paperback) showed editions of the
  same book share an identical `title` string, so this is enough to catch
  the real cases without pulling in `pg_trgm`/`word_similarity`, which is
  built for typo-tolerant search, not exact-duplicate detection.
- The dedupe helper (`dedupeByTitle` in `src/lib/dedupe.ts`) is shared
  between both services rather than duplicated.

## Out of scope

- `GET /books`, `GET /books/search`, and `GET /books/:id` are untouched —
  those are catalog-browse endpoints where seeing every edition of a title
  is expected, not a bug. Dedup only applies to the four
  recommendation/feed-style endpoints listed above.
- No fuzzy/near-duplicate title matching (e.g. punctuation-only
  differences) — exact normalized match only.
- No DB schema or migration changes; this is service-layer logic only.

## How it was verified

`npx tsc --noEmit` after each change, plus a live run of
`booksService.similar(461, 10)` against the Render Postgres database (book
461 is the hardback edition of "A Care Crisis in the Nordic Welfare
States?", whose paperback edition — id 463 — has a separate ISBN13):
returned exactly 10 results with no duplicate titles.
