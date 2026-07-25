# Make book/author search actually use its trigram index

**Date:** 2026-07-25

## What changed

Follow-up to
[2026-07-25-books-recommendations-performance.md](2026-07-25-books-recommendations-performance.md).
While verifying that fix with `EXPLAIN` against a real database, found that
search-driven queries — `GET /books?q=...`, `GET /books/search` (both
`type=title` and `type=author`), and `authorSuggestions` — were still doing a
full sequential scan on every uncached request, regardless of the trigram
index, because of how the fuzzy-match condition was written.

In [books.service.ts](../src/services/books.service.ts), the WHERE clause
called `word_similarity(q, column) > 0.3` as a plain function. Postgres's
planner cannot use a `pg_trgm` GIN/GIST index for that form — only the
operator form (`q <% column`) is index-eligible. Since this condition was
OR'd together with the ILIKE/full-text branches, the one non-indexable
branch forced the entire OR expression to fall back to a sequential scan.
Confirmed via `EXPLAIN` on the dev database (83k rows in `books` today,
growing via ongoing Gardners ingestion):

```
Seq Scan on books  (cost=0.00..16807.98 rows=27907 width=4)
  Filter: (title ~~* 'harry%' OR title ~~* '% harry%'
           OR word_similarity('harry', title) > 0.3 OR ...)
```

Changed all three call sites (`buildSearchCondition`,
`buildAuthorBookSearchCondition`, `authorSuggestions`'s inline condition) to
use `q <% column` instead.

## Why the threshold needed extra handling

`<%` reads its cutoff from the `pg_trgm.word_similarity_threshold` session
GUC rather than taking a literal argument — and that GUC defaults to `0.6`,
stricter than the `0.3` these queries were written against. Silently
inheriting the default would have meaningfully changed which books show up
in search results (fewer fuzzy matches survive at 0.6 than at 0.3) — the
kind of accuracy regression that's easy to miss because nothing throws an
error, results just quietly get narrower.

The initial plan was a persistent, database-wide `ALTER DATABASE ... SET
pg_trgm.word_similarity_threshold = 0.3` in `setup.ts`. That got dropped in
favor of a scoped fix — a `withWordSimilarityThreshold()` helper in
`books.service.ts` that opens a transaction, runs `SET LOCAL
pg_trgm.word_similarity_threshold = 0.3` (scoped to that transaction only,
so it can't leak onto unrelated queries that later reuse the same pooled
connection), then runs the query. This is pure application code — no
database-level configuration change, and no migration/setup script involved.

Applied to: `list()`'s two queries (row fetch + count), but only when
`opts.q` is set — the far more common plain-browse path (no search term)
never touches `<%` at all, so it keeps its original fully-parallel
`Promise.all` dispatch untouched. Also applied to `suggestions()`'s pool
query and `authorSuggestions()`'s query, both of which always have a search
term (zod requires `q.min(2)`).

## What's explicitly out of scope

- Did not re-verify the fixed query against a live `EXPLAIN` (i.e. confirm
  the planner now picks an index scan instead of a seq scan) — that requires
  the trigram indexes from `setup.ts` to actually exist on a database first,
  which per the `db:init` discussion in this same session, hasn't happened
  anywhere yet (Build Command currently only runs `db:migrate`). Worth
  re-running `EXPLAIN` on a real search query once that's sorted out.
- No change to `buildSearchOrderBy`/`buildAuthorBookSearchOrderBy` or the
  `CASE WHEN` ranking tiers — those still call `word_similarity()` as a
  plain function, which is correct there: by the time `ORDER BY` runs, the
  index-accelerated `WHERE` has already narrowed the row set down to actual
  matches, so scoring each of those with the real function is cheap.

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- No live database touched for this change (by design — see "why the
  threshold needed extra handling" above).
