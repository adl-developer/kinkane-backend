# Give every book a main genre

**Date:** 2026-09-04

## What changed

Books now carry a single primary genre in `books.main_genre_id`, taken from the
publisher's own nomination rather than guessed at. Nothing reads the column yet
— the API surface and the ingester write path come later in the rollout — so
this is the schema and the one-off backfill only.

The column is nullable and a large part of the catalogue is expected to stay
null. Measured on production 2026-09-04: of 2,029,071 live books, 1,415,382
(69.8%) carry a nomination, 609,215 have no genres at all, and 54,805 have no
Thema subject data of any kind. Every consumer has to render a book with no
main genre.

## Where the value comes from

ONIX lets a publisher mark one subject as the primary one — `<MainSubject/>`,
parsed into `book_subjects.is_main_subject`. That signal has been stored all
along but was never carried across into `genres`, so nothing in the app knew a
book's main genre. The backfill joins the scheme-93 flagged subject to the
genre sharing its `subject_code`.

Books that have genres but no nomination (4,474 on production) fall back to
their only genre when they have exactly one. A book with several genres and no
nomination is left null rather than guessed at.

## The rule that was rejected

The original design was to pick each book's main genre by whichever of its
genres is most common across the catalogue, cached behind a count column on
`genres`. Two measurements killed it.

It picks the vaguest label available. Thema codes are hierarchical, so the
commonest genre attached to a book is always its broadest ancestor — a title
tagged `NH`/`NHD`/`NHTB` resolves to "History" rather than "European history".
Ranked by that rule the catalogue's top genres come out as "History",
"European history", "Social and cultural history"; ranked by the publisher's
nomination they come out as "Crime and / or mystery fiction", "Picture
storybooks", "Modern and contemporary fiction" — actual shelf categories, and
a flatter distribution that discriminates better.

It also disagrees with the publisher on 37% of books (885,073 of 1,412,951
comparable rows agreed). There was no reason to prefer the frequency answer in
the other 527,878.

Dropping it removed the count column with it, which is the part that would
have hurt: a live counter maintained by trigger would have serialised every
`book_genres` insert on a handful of hot genre rows, exactly during the bulk
loads that write the most.

## Data model

`books.main_genre_id` — nullable integer, FK to `genres.id`, `ON DELETE SET
NULL`. Genres are not deleted in normal operation; set-null means a manual
cleanup degrades a book to "no main genre" rather than removing the book.

One index, `idx_books_main_genre`, on `(main_genre_id, updated_at)` and partial
on `WHERE is_removed = false`. Three details in that definition are
load-bearing, and each cost a wrong plan before being measured:

- **Composite, not single-column.** An index on `main_genre_id` alone still
  sorts every page.
- **Bare ascending `updated_at`.** The default listing sorts on a plain
  `books.updatedAt` (`buildSortOrderBy`), which is ASC. A `DESC` index — or an
  ASC one spelled `DESC NULLS LAST` — describes a different ordering and the
  planner sorts on top of it anyway.
- **Partial on `is_removed`.** Every list path pushes `is_removed = false`.
  Without it in the index the planner bitmap-ANDs this with
  `idx_books_is_removed`, and bitmap scans lose ordering, so the sort returns.

The result is a single index scan with no sort node for a genre-filtered
listing.

Because `books` is ~2M rows, the index has a `CONCURRENTLY` twin in
`build-concurrent-indexes.ts`. Its SQL has to stay character-identical to the
migration's: `CREATE INDEX IF NOT EXISTS` matches on name, not definition, so a
mismatched twin would satisfy the migration while building something the
planner never uses.

## The backfill

`scripts/backfill-main-genre.ts`, run by hand rather than from a migration.

```
npx tsx scripts/backfill-main-genre.ts --dry-run   # counts, writes nothing
npx tsx scripts/backfill-main-genre.ts --yes       # required off localhost
npx tsx scripts/backfill-main-genre.ts --from 812000
```

Keyset ranges over `books.id`, 25,000 rows a batch, each its own transaction —
the same shape as the GARDBIB bulk load, and for the same reasons. Every
`UPDATE` carries an `IS DISTINCT FROM` guard, so re-running writes nothing and
creates no dead tuples; that makes interruption cheap, and `--from` exists only
to skip work rather than to make a resume correct.

Two guards worth knowing about. Off localhost it refuses to write without
`--yes`. And on a database where the column does not exist yet it refuses to
write at all, while still running a dry run — previewing the numbers before the
migration ships is most of the reason to have a dry run.

Withdrawn books (`is_removed`) are backfilled too. They are absent from the
partial index and from every listing, but the flag clears when Gardners
reissues a title, and a reissued book should not come back genre-less.

## Verified

Applied and backfilled against a local copy of the catalogue: 75,784 of 83,688
books (90.56%), matching the dry run's prediction exactly. Zero books ended up
with a main genre they do not actually hold. Re-running wrote zero rows. An
interrupted first run resumed correctly, skipping the batches it had already
committed.

The plan was checked against the query planner rather than assumed —
`EXPLAIN ANALYZE` on a genre-filtered default listing shows an index scan on
`idx_books_main_genre` with no sort node, 17 buffers, 0.03ms.

Production sizing, from read-only measurement: ~1,412,951 rows for the first
pass and at most 6,905 for the fallback, taking coverage to ~69.9%. Expect
45–85 minutes for the run.

## Not in scope

The API does not expose the column yet, and no ingestion path maintains it — a
delta ingest that rewrites a book's subjects will currently leave its main
genre stale. Both land in later phases, along with recovering the 609,215
books that came through the Gardners bulk load with Thema codes but no genre
names.
