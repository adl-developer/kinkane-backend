# Make book/author search skip the expensive matching tiers when a plain prefix match already exists

**Date:** 2026-07-26

## What changed

`booksService.suggestions()` (backing `GET /books/search`, both `type=title`
and `type=author`) and `booksService.authorSuggestions()` (backing
`GET /authors/search`) previously matched in one query across four OR'd
tiers — exact prefix, word-prefix, trigram `word_similarity`, and full-text —
then ranked and limited the combined result.

`EXPLAIN (ANALYZE, BUFFERS)` against the live database for `q=harry` showed
why that's expensive: the trigram tier alone matched 57,380 of the ~1.1M
rows, and Postgres had to pull all ~73,000 combined candidate rows off disk
and sort them to return the top 24. Measured at **27.8s execution time**;
`GET /books/search?q=harry` measured ~33.5s end-to-end, and the author
variant exceeded a 35s client timeout entirely.

Now each function tries tiers 0-1 (exact/word prefix) alone first — an index
scan on the existing trigram GIN index, tens of ms even unfiltered — and
only issues a second query for tiers 2-3 (trigram similarity + FTS,
excluding whatever tier 0-1 already found) if that didn't fill the requested
result pool. New helpers: `buildTitlePrefixCondition`/`buildTitlePrefixOrderBy`,
`buildAuthorPrefixCondition`/`buildAuthorPrefixOrderBy`, and
`buildPersonNamePrefixCondition`/`buildPersonNamePrefixOrderBy`
([books.service.ts](../src/services/books.service.ts)) — deliberately subsets
of the existing `buildSearchCondition`/`buildAuthorBookSearchCondition`
tiers, not a new matching scheme.

Re-tested the same `q=harry` cheap-tier query after the change: **15.4ms
execution** (down from 27.8s). End-to-end: `GET /books/search?q=harry` from
~33.5s to ~2.3s (against this local dev network path — see "known caveat"
below), cached repeat requests unaffected at 1-2ms.

## Why

Since a real prefix match exists for the large majority of typeahead
queries, this skips the expensive tiers entirely in the common case. The
final ranking is unchanged — tier 0-1 results are still ordered ahead of
tier 2-3 results, since the cheap-tier results are computed and placed first
and the broad-tier query only fills in the remainder.

## Non-obvious decisions

- **Only changed `suggestions()`/`authorSuggestions()` (the typeahead
  endpoints), not `list()`'s `q`-driven paginated browse
  (`GET /books?q=`).** Both share the same underlying tier builders, but
  `list()` also returns an exact `total` for pagination — deciding whether
  that total should reflect only the cheap tier or the full four-tier match
  (and how that interacts with a user paging past the cheap tier's results)
  needs its own design pass, not a quick reuse of this pattern. `list()`'s
  `q` path still uses the original, unconditional four-tier query; it's
  correct, just potentially slow for the same reason on rare queries with
  large trigram matches. Flagged as a follow-up.
- **The broad-tier fallback query excludes already-found IDs
  (`notInArray`)** rather than just re-running the full condition and
  relying on later deduping — avoids re-fetching and re-ranking rows the
  cheap tier already returned.

## What's explicitly out of scope

- No change to the four-tier matching logic itself (`buildSearchCondition`,
  `buildAuthorBookSearchCondition`) — still used as-is for the broad-tier
  fallback and, unchanged, for `list()`'s `q` path.
- `list()`'s `q`-driven browse path (see above) — not touched in this pass.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- `EXPLAIN (ANALYZE, BUFFERS)` against the live database, before and after,
  for the cheap-tier query shape.
- Hit the running dev server's `GET /books/search?q=harry` (title and
  author) and `GET /explore/trending` before and after, cold and cached.
- **Known caveat:** end-to-end timings quoted above were measured from a
  local dev machine with a separately-diagnosed ~120ms-per-round-trip network
  distance to this database (see prior investigation in this same session) —
  the query-level `EXPLAIN ANALYZE` numbers are the reliable, network-independent
  evidence; the production deployment has near-zero latency to this database
  (confirmed separately) and should see the full benefit of the query-time fix
  without that added network overhead.
