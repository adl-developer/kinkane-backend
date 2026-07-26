# Fix `GET /books?q=` timing out on common search terms, and add a fast indexed prefix tier to both search endpoints

**Date:** 2026-07-26

## What changed

`booksService.list()` (backing `GET /books?q=`, the main paginated book
list/search) previously ran a single unconditional four-tier OR'd match —
exact prefix, word-prefix, trigram `word_similarity`, and full-text — for
*both* the row fetch and the `COUNT(*)` used for pagination's `total`, no
matter how common the search term was. This is exactly the gap the prior
[tiered-search-matching](2026-07-26-tiered-search-matching.md) change
explicitly flagged as a follow-up (it only fixed `suggestions()`/
`authorSuggestions()`, not this path).

Measured against the live database: `q=the`, `q=love`, `q=war` — 20-53s.
`q=` values with few matches were unaffected (sub-second).

`list()` now tries the same cheap tiers 0-1 (exact/word prefix, via the
existing trigram GIN index) before the expensive tiers, mirroring
`suggestions()`'s approach — but pagination's `total` needs an actual count,
not just a limited pool, so this needed its own decision logic (see "Non-obvious
decisions").

While testing, a second, more extreme case surfaced: even tiers 0-1 alone
degrade for very common prefixes. `EXPLAIN ANALYZE` for `q=the` showed the
trigram GIN index returning a *lossy* bitmap (~322k of 1.1M rows match the
prefix alone) — Postgres has to reread and recheck ~174k heap pages before it
can sort and limit, ~4.3s just for that "cheap" tier. There's no
case-insensitive-friendly index on `title` today — the existing
`idx_books_title` is a plain case-sensitive btree, useless for `ILIKE`.

Added a new tier ahead of tiers 0-1: an exact-prefix match backed by a new
functional index, `idx_books_title_lower_pattern` (`lower(title) text_pattern_ops`,
added via `CREATE INDEX CONCURRENTLY` in [setup.ts](../src/db/setup.ts), following
this repo's existing convention for opclass-dependent indexes that can't be
expressed in the Drizzle schema — see the neighboring trigram/HNSW indexes).
This tier's cost is independent of how common the prefix is — a genuine
indexed range scan instead of a bitmap scan over hundreds of thousands of
candidate rows. Applied to both `list()` and `suggestions()` (title path
only — see "What's explicitly out of scope").

New helpers in [books.service.ts](../src/services/books.service.ts):
`buildFastTitlePrefixCondition`/`buildFastTitlePrefixOrderBy`.

Re-tested against the live database after the fix (fresh, uncached terms,
from a local dev server — see the network-distance caveat in the prior
tiered-search-matching entry):

| Term | `GET /books?q=` before | after |
|---|---|---|
| `the` | 53s | **4.5s** |
| `love` / `war` | 20s | **0.7-0.8s** |
| `murder` / `shadow` / `mountain` / `legend` | 20s+ | **0.7-1.1s** |

`the` remains a multi-second outlier — see "What's explicitly out of scope."

## Why

Same rationale as the prior `suggestions()` fix: a real prefix match exists
for the large majority of queries, so trying the cheapest tier that could
possibly answer the question — before ever touching the tiers that force
Postgres to materialize and rank every fuzzy match — avoids the expensive
path entirely in the common case.

## Non-obvious decisions

- **Rows and count are decided independently, each against its own
  threshold**, because they have different correctness requirements. Rows
  only need a tier with enough matches to fill the *requested page*
  (`offset + limit`) — if a cheaper tier already has enough, its rows are
  provably identical to what a broader tier would return for that same page,
  because the broader tier's extra rows always rank behind the cheaper
  tier's (same ordering: prefix, then word-prefix, then similarity/FTS), so
  they'd never appear in that window anyway. This is *not* an approximation.
  Count is different: it's reported from the first tier that clears
  `SEARCH_COUNT_THRESHOLD` (500) as a **known lower-bound approximation** —
  the true total may include additional matches from a broader tier — rather
  than paying for an exact `COUNT(*)` on a term common enough to make that
  expensive in the first place. Both decisions are made once per request,
  independent of which page triggered them, and the count is cached under a
  page-independent key, so every page of the same query agrees on the same
  total instead of it drifting by whichever page happened to compute it
  first.
- **The fast tier's `ORDER BY` must be `lower(title)`, not `title`.** Caught
  via `EXPLAIN ANALYZE` before shipping: ordering by plain `title` makes
  Postgres discard the new index entirely (its output isn't sorted by plain
  `title`) in favor of the existing case-sensitive `idx_books_title` — which
  degenerates into scanning ~800k rows one at a time for a common prefix
  (70s+), since e.g. "The", "the", "THE" sort nowhere near each other in a
  case-sensitive index. This is exactly the regression the new index exists
  to avoid, so the order-by has to match the exact expression the index is
  built on.
- **Dropped an unnecessary transaction wrapper.** Neither the new fast tier
  nor the existing tiers 0-1 use the `<%` trigram-similarity operator, so
  neither needs `withWordSimilarityThreshold` (which exists solely to `SET
  LOCAL` a GUC that operator reads). Only the broad tier does. Both
  `list()` and `suggestions()` were wrapping tiers 0-1 in that transaction
  unnecessarily before this change; now the wrapper is only applied when the
  broad tier actually runs.
- **`CREATE INDEX CONCURRENTLY`, not a Drizzle-managed migration.** Same
  convention as the existing trigram/HNSW indexes in `setup.ts` — Drizzle's
  migration flow can't express opclass-specific indexes, and can't emit
  `CONCURRENTLY` at all (which matters here: it avoids locking `books`
  against reads/writes while the index builds against the live table).
  `setup.ts` runs automatically via `preDeployCommand` on every deploy — so
  this build rides along with the next deploy, not a separate manual step.
- **Manually ran `ANALYZE books` against the live database during
  diagnosis.** `pg_stat_user_tables` showed `last_analyze`/`last_autoanalyze`
  both `null` and `n_live_tup = 0` for a table with 1.1M real rows —
  planner statistics had apparently never been collected, which was
  independently responsible for several bad plan choices seen during this
  investigation (wildly wrong row-count estimates). This isn't part of the
  code change and isn't something `setup.ts` re-runs — worth someone
  checking why autovacuum/autoanalyze hasn't run on this table.

## What's explicitly out of scope

- **Author-name search** (`buildAuthorPrefixCondition`/
  `buildAuthorBookSearchCondition`, `type=author` on `GET /books/search`) has
  the same theoretical problem for common surnames but no equivalent index —
  `idx_books_title_lower_pattern` only covers `books.title`, not
  `book_contributors.person_name`. Left as-is.
- **`q=the` (and similarly extreme single common-word queries) is still a
  few seconds, not sub-second.** `EXPLAIN ANALYZE` traced this to a genuine
  Postgres planner limitation: for this combination (expression index +
  parallel workers + a range derived from a `LIKE` pattern), Postgres
  inserts a `Sort` node before the `LIMIT` instead of streaming the
  already-ordered index scan and stopping early — confirmed with `SET
  enable_sort = off`, which still produced a (merely disabled, still
  executed) `Sort` node, meaning no alternative plan exists for the planner
  to fall back to. Not pursued further — this is an intentionally extreme
  edge case (no real user meaningfully searches "the" as a book title), and
  the fix already brought it down from 53s to ~4.5s.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- `EXPLAIN (ANALYZE, BUFFERS)` against the live database at each stage of
  diagnosis (four-tier query, isolated tier-0, fast-tier with and without
  the new index, with and without `ANALYZE`, with and without parallel
  workers, with `enable_sort` off).
- Built the index against the live database and confirmed via
  `pg_indexes`/`pg_index.indisvalid`.
- Ran the local dev server against the live database (via a `.claude/launch.json`
  preview config, not committed) and hit both endpoints before/after, cold
  and cached, for previously-slow and previously-fast terms.
- Caught and fixed the `ORDER BY` bug above via a first end-to-end pass that
  came back *worse* (45s) than before the fix — re-verified clean after
  correcting it and flushing the local Redis cache to rule out a stale
  cached result.
