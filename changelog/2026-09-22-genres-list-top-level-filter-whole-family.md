# Genres list shows top-level names, and a genre filters its whole family

## What changed

`GET /genres` now lists each top-level genre once, the same way book
responses already show genres (see `2026-09-22-top-level-genre-names.md`).
Tapping a genre now filters by that whole top level, not by one sub-genre.

| Before | After |
|---|---|
| 2,185 entries, e.g. "Literary studies: general", "Literary studies: poetry and poets", … | 1,858 entries, e.g. one "Literary studies" |
| `slug` filtered to one stored genre | `slug` filters to every genre under that top level |

On the local catalogue copy, `?genre=literary_studies` returns 3,143 books,
across the 8 stored genres in that family. The old
`?genre=literary_studies_general` returned 1,004.

## API shape

- `GET /genres` → `{ genres: [{ id, name, slug }] }`, same shape as before.
  - `name` is the top-level name (the part before the first colon).
  - `slug` is the **family slug**: the top-level name slugified the way the
    ingester slugifies every genre (`literary_studies`). A genre with no colon
    already had this slug, so it doesn't change.
  - `id` is the first stored genre in that family. It names one genre, not the
    family, so clients should filter on `slug`.
  - Sorted alphabetically by the shortened name.
- Book responses: `genres[].slug` is now the family slug too. This replaces
  the first sub-genre's slug that the earlier change kept. A chip on a book and
  the matching entry in `GET /genres` carry the same slug and filter the same
  way.
- `?genre=` on `GET /books` (v1 and v2) accepts:
  - a family slug, which matches every genre under that top level;
  - an older full slug, such as `literary_studies_general`, which still matches
    only that genre, so slugs clients saved earlier keep working;
  - an unknown slug, which returns no books, as before.

## Decisions worth knowing

- **The family slug reuses the ingester's slugify on purpose.** A genre with
  no colon has to land in its own family, so the family slug must equal the
  stored slug. All 2,185 stored slugs were checked against the mirrored
  function and all 2,185 match.
- **Families are deduped on the slug, not the name.** Headings that differ
  only in punctuation, like "Children's" and "Children’s", slugify the same and
  filter the same, so they appear as one entry.
- **The slug is resolved to genre ids once, in `booksService.list`.** Eight
  list and search paths share one synchronous WHERE builder, so the lookup
  happens before any of them run. The resolved ids go into the options that
  every list, count and band cache key hashes. Filters whose results change get
  new keys automatically, and the cache version prefixes didn't need a bump.
- **`genres:all` still caches the stored rows.** The top-level list is derived
  on read, so no entry in that cache has the wrong shape. The trade-off: a genre
  first ingested within the hour isn't in its family, and its slug matches
  nothing, until that cache expires. That's up to one hour.
- **Unchanged:** stored genre names and slugs, the recommendation engine, and
  the onboarding quiz's own genre vocabulary.

## Left out of scope

- Several genres in one `?genre=` request. The old parameter doc said names and
  comma-separated lists worked, but the code only ever matched one slug. The doc
  now describes what the code does.

## How it was verified

- Unit tests cover:
  - the family slug, including the fallback when a top level has no slug-safe
    characters;
  - collapsing by case and by punctuation;
  - re-normalising a cached book page onto the family slug;
  - top-level list order and ids;
  - resolving a family slug, an old full slug and a near-prefix to genre ids.
  Full suite passes (981 tests).
- Against the local catalogue, with the server running:
  - `GET /genres` returns 1,858 entries, none containing a colon, no duplicate
    slugs, in alphabetical order.
  - `?genre=educational` returns 2,783 books, and their chips carry
    `educational`.
  - `?genre=literary_studies` returns 3,143 books, against 1,004 for
    `literary_studies_general`.
  - An unknown slug returns 0.
