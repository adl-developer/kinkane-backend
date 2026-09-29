# Main genre in book responses

**Date:** 2026-09-29

## What changed

`GET /books` (v1 and v2) and `GET /books/:id` now return `mainGenre` on every
book: the publisher's nominated primary genre from `books.main_genre_id`
(see 2026-09-04-main-genre.md).

```json
"mainGenre": { "name": "Crime and / or mystery fiction", "slug": "crime_and__or_mystery_fiction" }
```

It is `null` when the book has no nomination — about 30% of the catalogue —
and clients must render that case.

## Shape

Same display form as the `genres` entries: top-level name and family slug. So
`mainGenre` is always one of the book's `genres`, and its slug works as
`?genre=`. The specific heading below the colon is not exposed.

## Caching

- The list row cache moved to `books:list:v11`, since v10 pages have no
  `mainGenre`.
- `book:detail:{id}` keeps its name, because other services delete it to
  refresh a book page. A cached detail without a `mainGenre` key is rebuilt
  instead of being served, so old entries don't show `null` for up to an hour.

## Still not in scope

The ingester still doesn't maintain the column. A delta ingest that changes a
book's subjects leaves `mainGenre` stale until the backfill is run again.
There is also no `?mainGenre=` filter yet.
