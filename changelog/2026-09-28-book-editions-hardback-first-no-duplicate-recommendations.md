# Search shows every edition hardback first; recommendations never show one book twice

## What changed

- **Search lists every edition, hardback first.** `GET /books?q=` and
  `GET /books/search` used to show one edition per title. Now they show every
  edition, with each book's editions kept together. Within a book the order is:
  editions on the shelf, then order-in, then unavailable; within each of those,
  hardback, then paperback, then anything else. Books keep their relevance order
  relative to each other. A page never splits a book's editions, so a page can
  run a few rows past `limit`.
- **Browsing (no `q`) still shows one edition per title**, but hardback now wins
  over paperback when stock is equal. Before, paperback won.
- **The quiz never recommends a book the reader just picked, under either
  spelling.** Picking "Secret Lives of Baba Segi's Wives" now also excludes
  "The Secret Lives of Baba Segi's Wives". The same applies to books on the
  shelf and books swiped away, on every recommendation surface: quiz results,
  the personalized feed, "you may also like", the basket suggestions, the
  reader-type rail and recommendation emails.
- **A recommendation list shows each book once.** "X" and "The X" by the same
  author count as one book. The edition shown is: one on the shelf (where stock
  is known), then one with a cover, then the newest, then one with a price,
  then the one with the most data. Format plays no part here.
- Basket suggestions no longer offer a different edition of a book that's
  already in the basket.

## Why

The catalogue often holds one book under two titles: a reissue, a different
publisher, or simply "The" at the front. Readers were being recommended the
book they had just told the quiz they'd read, and some lists showed the same
book twice.

## How it works

- **Matching titles.** Two titles are the same if they match after lowercasing,
  treating "&" as "and", turning punctuation into spaces, and removing a leading
  or trailing "The/A/An". The JS function (`normalizeTitleForMatch`) and its SQL
  twin (`titleMatchSql`) live side by side in `lib/exclusions.ts`. They were
  checked against all 83,688 local catalogue titles and agree on every one.
  The SQL runs with the ICU collation because the database's ctype is C (under
  C, `lower()` and `[[:alnum:]]` only understand ASCII).
- Accents are **not** stripped: the database has no `unaccent` extension, and
  both sides of the comparison have to fold titles identically.
- Existing dislike snapshots don't need migrating. The new matching accepts the
  old stored form and produces the same result as it would from the raw title.
- The author is still required to match (or be unknown), so two different books
  that share a title stay separate.
- Cache keys bumped: `books:list:v9`, `suggestions:v5`, `trending:v7`,
  `personalized:v5`, `similar:v6`.

## Out of scope

- Grouped search pages carry row ids in the cursor rather than titles.
- Deduped search misses some books whose titles contain the query but don't
  start with it, e.g. "The Art of Harry Potter" for "harry potter". This
  happened before this change too and is left for a separate fix.
- A recommendation email doesn't check whether a different edition of the same
  book was already emailed; the email log is per edition.

## How it was verified

- Unit tests: the edition picker, grouping, the recommendation picker order,
  work dedupe, and the folded exclusion match. Full suite: 1088 passing.
- Against the local database:
  - JS and SQL title folding agree on 83,688 of 83,688 titles.
  - Excluding "aeneid" removes all five "Aeneid"/"The Aeneid" rows.
  - A 200-work exclusion over 20k rows runs in about 66ms. Moving the title
    folding into a subquery measured ten times slower, so it wasn't used.
- Searching "aeneid" page by page with the cursor returned all 14 matches, none
  repeated. "The Aeneid" and "Aeneid" by Vergil appear as one group, ordered
  in-stock paperbacks, then the order-in hardback, then the order-in paperback.
