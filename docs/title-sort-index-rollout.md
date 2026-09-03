# Creating the title-sort indexes without locking the catalogue

Migration `0056_books_title_sortable_index.sql` adds two expression indexes to
`books`, which has ~2M rows. They are what keeps `GET /books?sortBy=title` an
ordered index scan now that it sorts on a placeholder-title rank before the
title itself — see `buildSortOrderBy` in `src/services/books.service.ts`.

**The deploy handles this on its own.** `db:migrate` runs
`src/db/build-concurrent-indexes.ts` ahead of `drizzle-kit migrate`, which
builds both indexes `CONCURRENTLY`; the migration then finds them present, its
`IF NOT EXISTS` makes it a no-op, and nothing takes a write lock on `books`.
You do not need to do anything by hand. The rest of this page is what that
script is doing and when to step in.

## Why it is a script and not just the migration

A plain `CREATE INDEX` takes a `SHARE` lock on `books` for the length of the
build — minutes at this row count — and a `SHARE` lock blocks writes. Anything
mid-flight that writes to `books` waits it out: the ONIX ingester's chunk
pipeline, a bulk `COPY`-to-staging merge, the Gardners feed run. Since
`preDeployCommand` is `npm run db:init`, the deploy blocks behind it too.

`CREATE INDEX CONCURRENTLY` does not block writers, but it cannot run inside a
transaction block and drizzle-kit wraps every migration in one. That conflict is
the only reason the pre-build step exists.

**The expression has to stay identical in three places**: the migration, the
pre-build script, and `buildSortOrderBy`. If any copy drifts, Postgres treats it
as a different expression, the planner matches no index, and the page silently
goes back to sorting the whole filtered set. `title-sort-placeholders.test.ts`
asserts all three against each other, so drift fails the suite rather than
production.

## What a deploy looks like

The build is slower in wall-clock terms than the locking one — two passes over
the table instead of one — so the first deploy after this lands will sit on
`building concurrently, this can take several minutes...` before the migration
runs. That is the trade: a longer deploy, no stalled writers. Subsequent deploys
cost one catalog query per index and log `already built`.

If the concurrent build fails, the script is deliberately **not** fatal. It drops
whatever half-built index it left behind, logs the failure, and lets the release
continue — the migration then builds the index under a lock, exactly as it would
have without the script. A worse deploy, not a broken one.

## Doing it by hand

Only needed if you want the indexes in place *without* a deploy, or the
automatic step failed and you would rather not wait for the next release.
`CONCURRENTLY` cannot run inside a transaction block, so use `psql` directly —
not a migration, not a wrapper that opens one.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS \"idx_books_title_sortable\" ON \"books\" USING btree ((CASE WHEN \"title\" ~ '[[:alnum:]]' THEN 0 ELSE 1 END), \"title\");"
```

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS \"idx_books_title_sortable_desc\" ON \"books\" USING btree ((CASE WHEN \"title\" ~ '[[:alnum:]]' THEN 0 ELSE 1 END), \"title\" DESC);"
```

One at a time, not in one `-c`. Each takes two passes over the table and does
not block writes, so it is slower in wall-clock terms than the locking build —
that is the trade being made.

## Checking they are valid

The script does this itself — it drops an invalid index and rebuilds it — so
this is for a hand-run build, or for confirming what the deploy did.

A `CONCURRENTLY` build that fails partway leaves the index **in place but
invalid**: unusable by the planner, and — this is the trap — enough to satisfy
the migration's `IF NOT EXISTS`, so the deploy will skip past it and the page
will be slow with no error anywhere.

```bash
psql "$DATABASE_URL" -c "SELECT c.relname, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname LIKE 'idx_books_title_sortable%';"
```

Both rows must read `t`. Any `f` — drop that one and build it again:

```bash
psql "$DATABASE_URL" -c "DROP INDEX CONCURRENTLY \"idx_books_title_sortable\";"
```

## Confirming the page uses them

After the deploy, whichever way the indexes got built:

```bash
psql "$DATABASE_URL" -c "EXPLAIN SELECT id FROM books WHERE is_removed = false ORDER BY (CASE WHEN title ~ '[[:alnum:]]' THEN 0 ELSE 1 END), title ASC LIMIT 20;"
```

Expect an `Index Scan using idx_books_title_sortable`. A `Sort` node over a
`Seq Scan` means the expressions have drifted apart — compare the `CASE` in
`buildSortOrderBy` against `pg_get_indexdef` character for character.

Repeat with `title DESC` to check the descending index; note that the rank stays
`ASC` in both queries, which is exactly why there are two indexes rather than one
read backwards.

## Removing the pre-build later

Once both indexes exist on every environment that matters, the entry in
`INDEXES` is dead weight — it costs a catalog query per deploy and nothing else.
It is worth leaving in place anyway: it is also what rebuilds the index if one
is ever dropped, and what makes a fresh database (a restored dump, a new staging
environment) get them without a lock. Delete it only along with the migration.
