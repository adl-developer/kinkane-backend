# Sink placeholder titles to the bottom of a title-sorted book list

**Date:** 2026-09-03

## What changed

`GET /books?sortBy=title` opened on the catalogue's junk. A handful of ingested
rows have a title that is punctuation and nothing else — `?`, `.`, `...`, `-`,
the occasional empty string — and in ASCII order every one of them sorts ahead
of every real book. The first page of an A–Z browse was placeholders.

They now sort last. The ordering gained a rank key ahead of the title:

```sql
ORDER BY (CASE WHEN title ~ '[[:alnum:]]' THEN 0 ELSE 1 END), title ASC|DESC
```

Rank 1 is "no letter or digit anywhere in the title". Deliberately *anywhere*
rather than the simpler "doesn't start with one", which would have buried real
books: quoted titles (`"The Nose"`) turn up four times in a 1,000-row sample of
the live catalogue, and `#Girlboss`-style titles are the same shape. NULL titles
rank 1 too — `NULL ~ '…'` is NULL, so the CASE falls to its ELSE — which is the
answer we wanted anyway and saves a separate `NULLS LAST`.

The rank is always `ASC`, including when the title is `DESC`. "At the bottom" is
a statement about the page, not about the sort direction, so reversing the title
must not float the placeholders back to the top.

`sortBy=newest` and the default `updated_at` ordering are untouched. A bare
`sort=asc|desc` — which has meant title since before `sortBy` existed — gets the
new behaviour, since it is the same ordering.

## Keeping it off a sequential scan

Ordering on an expression makes `idx_books_title` unusable for the page: its
order no longer satisfies the `ORDER BY`, so Postgres sorts the whole filtered
set before `LIMIT` can apply. On a ~2M-row catalogue that is the entire cost of
a browse page — the same regression shape already documented on
`buildFastTitlePrefixOrderBy`.

Migration `0056` adds two indexes carrying the expression as their leading key.
Two, because the rank does not reverse with the title: `sort=desc` means
(rank ASC, title DESC), which is not a backwards read of the ASC index, as a
backwards scan reverses every key at once.

## Building them without locking the catalogue

A plain `CREATE INDEX` holds a `SHARE` lock on `books` for the length of the
build, which blocks every writer — the ONIX chunk pipeline, a COPY-to-staging
merge, a Gardners feed run — and, since migrations run in `preDeployCommand`,
the deploy as well. `CREATE INDEX CONCURRENTLY` doesn't block writers but is
illegal inside a transaction block, and drizzle-kit wraps migrations in one.

So `db:migrate` now runs `src/db/build-concurrent-indexes.ts` first. It builds
these indexes concurrently, the migration finds them present, and its
`IF NOT EXISTS` turns into a no-op. The script is idempotent (one catalog query
per index once they exist), skips tables that don't exist yet so a fresh
database is unaffected, and rebuilds any index left **invalid** by a failed
concurrent build — an invalid index is unusable by the planner but still enough
to satisfy `IF NOT EXISTS`, which would otherwise make the migration skip it and
leave the page quietly slow.

A failed concurrent build is not fatal: it drops the half-built index, logs
which migration will build it under a lock instead, and lets the release
continue. Worse deploy, not a broken one.

Expect the first deploy carrying this to pause on the concurrent build before
migrations run. `docs/title-sort-index-rollout.md` covers that, the manual
`psql` route, and how to confirm the planner is actually using the indexes.

## Verified

Type-check passes. Nine new tests in `title-sort-placeholders.test.ts` assert
the generated SQL rather than executing it (the house style for query-shape
properties): that the rank doesn't flip with the title, that the regex isn't
anchored, that `newest` and the default ordering are untouched, and that the
`CASE` is character-identical across all three places it appears — the service,
the migration and the pre-build script — since drift means the planner matches
no index and the page silently regresses.

The indexes have not been created on production; that happens on the next
deploy.
