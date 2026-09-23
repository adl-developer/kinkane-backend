# Books show top-level genre names

## What changed

Genres on books are now shown as their top-level name only: everything after
the first colon is dropped.

| Stored genre | Shown as |
|---|---|
| Literary studies: poetry and poets | Literary studies |
| Children’s / Teenage general interest: Ball games and sports: Cricket | Children’s / Teenage general interest |
| Crime and mystery | Crime and mystery (unchanged) |

When several of a book's genres shorten to the same name, the book shows that
name once. For example, "Literary studies: general" plus "Literary studies:
poetry and poets" shows as a single "Literary studies".

This applies to every book response: `/books` lists (v1 and v2), search, the
book page, the discovery feeds, recommendations built from the same list code,
and a user's reading shelves. 487 of the 2,185 genres contain a colon.

## API shape

- `genres[].name` is the shortened name.
- `genres[].slug` is **unchanged**: it is the original genre's slug. Passing it
  to `?genre=` filters exactly as before. When names collapse, the first
  genre's slug is kept.
- `GET /genres` (the full genre list used to build filters) still returns full
  names. It was deliberately left out of scope.

## Decisions worth knowing

- **Display only.** The database is unchanged. The recommendation engine and the
  reader-type logic read full genre names to score and describe books. Those
  never reach the app, so they still get the full headings.
- **Book pages are fixed on every read, not by renaming the cache key.** The
  book-page cache key is deleted elsewhere to refresh a page when new reviews
  arrive (on the BDS branch). Renaming it here would have broken that when the
  branches merge. The shortening runs again on the way out and is idempotent,
  so a page cached before this change is corrected too. List and feed caches
  already moved to new keys on this branch, which isn't deployed yet.
- **Case-insensitive collapsing.** "Fantasy: epic" and "fantasy" count as the
  same top level.

## How it was verified

- Unit tests for the name rule (first colon only, several colons, no colon,
  a name starting with a colon), collapsing with the first slug kept, and
  idempotency. Full suite passes (964 tests).
- Checked live against a local copy of the catalogue. Book 34 is stored with
  three colon genres, two sharing a top level, and returns two:
  "Children’s / Teenage" and "Children’s / Teenage general interest". A
  cached read returns the same. Across the book page, browse (with and without
  dedupe), a search, a `?genre=` filter by a full slug, trending and similar:
  no returned genre contains a colon, no book repeats a name, and every slug is
  a real genre slug.
