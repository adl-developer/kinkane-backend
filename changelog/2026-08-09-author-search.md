# Book search matches author names

## What changed

`GET /books` and `GET /books/search` now match a query against the book's author
as well as its title. Typing "Roderick Hunt" returns that author's books instead
of a page of titles that happen to contain the word "Hunt".

No new query parameters on `GET /books` — `q` simply matches more. On
`/books/search`, the existing `type` parameter gained an `all` value, which is
now the default; `type=title` and `type=author` still behave as before for any
caller that passes them.

## Why

Author search was half-built. `/books/search?type=author` existed but required
the client to know in advance that the user was typing a name, and `GET /books`
had no author path at all. Neither is how someone searches: they type "Jeff
Kinney" into one box and expect the Wimpy Kid books.

## How it works, and why it isn't one query

Each search runs as two independently-bounded branches — one matching titles,
one matching author names — merged in memory. The obvious implementation (OR the
author condition into the existing title condition) is the wrong shape here: the
title branch's speed comes from its `ORDER BY` matching an index's own ordering,
and a blended query has to rank title matches against author matches, which no
single index can order. Postgres would sort the entire candidate set — for a
common prefix like "the" that's ~322k rows on the production catalogue, the exact
regression `idx_books_title_lower_pattern` was added to avoid. Split in two, each
branch keeps its own index-ordered plan and its own `LIMIT`, and the merge is over
at most 2×(offset+limit) rows.

Which branch leads depends on how well titles matched. At the prefix and
word-prefix tiers, titles lead — a query is more often a title than a name. At
the fuzzy tier, where nothing matched a title properly and the branch is
returning trigram near-misses, the author branch leads: an exact name match is a
better answer than a fuzzy title one.

Both endpoints apply that rule. It is easy to implement in one and forget in the
other, and the failure is quiet — the endpoint still returns the right books,
just with a near-miss sitting in the top slot where the user is looking.

The author branch resolves in two steps — rank matching book ids in SQL, then
fetch those books — because the match tier lives in a subquery, and referencing
it per candidate row is a correlated subquery that Postgres re-runs for every row
it considers. That was the shape of the previous author-search helpers, and it is
why they were only ever safe in the small fixed pool of the typeahead.

New indexes on `book_contributors`, both partial on `role = 'A01'` since every
author query filters to it: a trigram GIN (replacing the unpartitioned one — the
predicate is part of an index's definition, so `CREATE INDEX IF NOT EXISTS` under
the old name would have been a silent no-op), and a `lower(person_name)
text_pattern_ops` btree that gives the prefix tier a genuine indexed range scan,
mirroring what `idx_books_title_lower_pattern` does for titles.

## Non-obvious decisions

**The reported total needed its own probe.** Tier selection measures the title
match set, because that's what it's choosing between. But `total` has to count
books matched by either side, so it's a third probe over the blended condition —
still capped at `SEARCH_COUNT_CAP`, still `max()` rather than a sum, since a book
can match both sides.

**The typeahead reserves a share of the list for whichever side isn't leading.**
Without a reserve, a query whose leading side already fills the pool pushes the
other out entirely — "king" would return books with "King" in the title and never
a Stephen King novel, which is the case the feature exists for. A third of the
list is enough to stay visible without displacing the better match.

**Author-match ranking has to be a total order, and the same one in SQL and in
memory.** The ranking query's `LIMIT` grows with the requested page, so page 2
samples more rows than page 1; with a partial ordering the two samples are
different arbitrary subsets of the tied rows and pages overlap. This was caught
in testing — a prolific author's page 2 repeated a book from page 1, because 171
rows tied at the same tier and Postgres was free to return any 30 of them.
Ordering by (tier, title, id) in both places makes each sample a prefix of the
next.

**Ids are over-fetched 5× for the author branch** because the genre/availability
filters apply to the book fetch, not to the ranking, so some ranked ids don't
survive them. Without the headroom a filtered author search under-fills its page.

## Out of scope

- `authorSuggestions()` (grouped author names with book counts) still has no
  route. If the UI wants an "Authors" section in the typeahead alongside books,
  that's a route addition on top of this.
- Denormalising author names onto `books` was considered and rejected for now.
  It would make deep pagination cheaper and remove a join, at the cost of a
  backfill over the whole catalogue, ingester changes in three write paths, and a
  permanent second source of truth that can drift. Worth revisiting only if deep
  pagination on search turns out to matter — nothing here would need unpicking.
- Searching by contributor roles other than author (editor, translator,
  illustrator) — deliberately excluded, and the indexes are partial on `A01`
  accordingly.

## Verification

Against a local copy of the catalogue (83,688 books / 126,664 contributors —
smaller than production's ~1.1M, so timings are directional, not a production
measurement):

- "Roderick Hunt", "Jeff Kinney", "Jennifer Dussling" and "Ordnance Survey"
  return those authors' books; "Ordnance Survey" correctly leads with its two
  genuine title matches before the author's own titles.
- "king", "the", "kinney" and "harry potter" still lead with title matches, with
  author matches holding their reserved share — checked after the lead-side rule
  was added to the typeahead, since that rule is what could regress them.
- Four pages of three different author searches: 20 rows each, zero duplicates.
- Cold-cache latency 52–243 ms on `/books` and 37–170 ms on `/books/search`
  across title queries, author queries, a very common prefix ("the"), a common
  name fragment ("jo", "smith") and a typo ("rodrick hnt"); warm 2–4 ms.
- `EXPLAIN (ANALYZE, BUFFERS)` confirms the author branch is served by the new
  partial trigram index, and the prefix tier by the new pattern index.
- `src/__tests__/author-search.test.ts` covers the cost properties of the
  generated SQL — per-branch caps, no correlated reference to the outer row, no
  sort on a computed expression, fuzzy tiers absent from the cheap condition —
  none of which are visible from the returned rows.
- Full suite: 97 passing. The 3 failures in `subscription-pricing.test.ts` are
  pre-existing and unrelated (confirmed by stashing these changes).
