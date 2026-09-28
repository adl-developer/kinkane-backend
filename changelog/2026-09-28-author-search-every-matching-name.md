# Return every matching author name, a page at a time

**Date:** 2026-09-28

## What changed

`GET /api/v1/authors/search` used to return only the first 8–15 matching names. It
ignored `offset`, so there was no way to see the rest. Searching "barbara" matches 189
names, but the endpoint only ever showed the top few by book count. Names like
"Barbara, PhD Fadem" (1 book) were never reachable, with or without a comma in the query.

The endpoint now pages through every match:

- **`offset` works**, and `limit` goes up to 50. The response is
  `{ authors, limit, offset, hasMore }`. Keep requesting with `offset + limit` until
  `hasMore` is `false`.
- **Every contributor role is included.** Names credited only as editor, translator or
  illustrator (e.g. "Barbara, PhD Minton", an editor) used to be excluded. They are now
  listed after authors of an equally good match. This matches book search, which
  already covered every role. `bookCount` counts books in any role.
- **Exact matches always come before fuzzy ones, across pages.** For "barbara", names 1–189
  are the names that contain "barbara" as a word. Similar-looking names ("Barbera", "Barber")
  only start at #190.
- **A single word matches after punctuation, not only after a space.** "roderick" now
  finds "J.Roderick Heller" as an exact match. This applies to author book search too,
  where "roderick" goes from 182 to 197 books.

The response keeps the `authors: [{ personName, bookCount }]` shape. `limit`, `offset` and
`hasMore` are new fields, so existing callers are unaffected. The OpenAPI spec previously
documented the field as `name`; it now says `personName`, which is what the endpoint has
always returned.

## Decisions

- **Order is total** (match tier → author before other roles → book count → name), so
  paging never repeats or skips a name. Verified by paging through all of "barbara":
  no duplicates.
- **Exact first, then fuzzy, without counting every page.** Each page fetches one row
  more than asked to set `hasMore`. The exact-match total is only counted when a page
  starts past the last exact match, because that is the one case where the fuzzy tier's
  offset can't be worked out from the page itself.
- **The typeahead's full-text arm was removed.** It matched whole words of the name,
  which the word-start match now already covers, and it had no index. Removing it took
  the fuzzy fallback from about 400ms to under 50ms locally, with the same results.

## Out of scope

- The fuzzy tail is long. "barbara" has several hundred near-miss names after the 189 real
  ones. A client building an infinite list may want to stop when the names stop
  containing the query. The API has no "exact only" switch yet.

## How it was verified

- All 189 "barbara" names are returned on pages 1–13, with no duplicates, and
  "barbara," returns an identical list. "Barbara, PhD Fadem" is #123 and
  "Barbara, PhD Minton" is #182.
- Timings on the local DB: 6–47ms for the typeahead, 9–130ms for author book search.
- Unit tests updated in `author-search.test.ts`, covering the single-word punctuation
  match and the two-letter guard.
