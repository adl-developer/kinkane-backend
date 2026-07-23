# Stop showing duplicate title+subtitle editions in search suggestions

**Date:** 2026-07-23

## What changed

`GET /books/search` (the search-suggestions endpoint) could return the same
book twice — one row per edition (e.g. hardback vs paperback) sharing an
identical title and subtitle. `booksService.suggestions()` in
`src/services/books.service.ts` now drops later duplicates, keeping only the
best-ranked edition of each title+subtitle pair.

## Non-obvious decisions

- **Keyed on title *and* subtitle, not title alone** — the existing
  `dedupeByTitle` helper (added for the trending/personalized/similar feeds,
  see `changelog/2026-07-14-dedupe-book-titles.md`) collapses on title only.
  Search suggestions can legitimately contain distinct books that share a
  title but differ by subtitle (e.g. different anthologies), so a new
  `dedupeByTitleAndSubtitle()` was added to `src/lib/dedupe.ts` instead of
  reusing/loosening the existing helper. `null` and `''` subtitles are
  treated as the same key.
- **Over-fetch, dedupe, then slice** — same pattern as the earlier feed
  dedup: the DB query now pulls a candidate pool of `min(limit × 3, 100)`
  rows instead of exactly `limit`, dedupes, then slices back to `limit`,
  before the contributor/excerpt lookups run (so no wasted work on rows
  that get dropped).
- This reverses the "out of scope" call made in
  `changelog/2026-07-14-dedupe-book-titles.md`, which explicitly left
  `GET /books/search` alone as a catalog-browse endpoint. Product wants
  search suggestions deduplicated too.

## Out of scope

- `GET /books` (catalog listing) and `GET /books/:id` are still untouched —
  seeing every edition is still expected there.
- `authorSuggestions()` (author-name autocomplete) is unaffected — it
  doesn't return book title/subtitle rows.
- No DB schema or migration changes; service-layer logic only.

## How it was verified

Added `src/__tests__/dedupe.test.ts` (new vitest setup for this repo,
mirroring `onix_ingester`'s convention) covering `dedupeByTitleAndSubtitle`:
exact title+subtitle duplicates collapse; same title with a different
subtitle is kept; same subtitle with a different title is kept; `null`/`''`
subtitles collapse together; matching is case-insensitive and
whitespace-trimmed; first occurrence wins and input order is preserved;
empty input returns empty output. `npx vitest run` (7/7 passing) and
`npx tsc --noEmit` both clean.
