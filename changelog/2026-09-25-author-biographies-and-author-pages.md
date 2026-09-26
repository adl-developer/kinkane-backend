# Author biographies on book pages, author pages, and a refresh that holds up

**Date:** 2026-09-25

Follows `changelog/2026-09-22-bds-author-bios-and-reviews.md`, which built the
connection to BDS. This is what happened once the account went live and the
data could actually be measured.

## What changed for readers

**A biography beside the author's name.** Book detail already carried a
book-level `authorBio`; each contributor can now carry their own:

```json
"contributors": [
  {
    "role": "A01",
    "personName": "Selina Brown",
    "sequenceNumber": 1,
    "bio": { "bioHtml": "<p>Selina Brown is an Author...</p>", "confidence": "high" }
  }
]
```

**An author page.** `GET /api/v1/authors/:name` returns the author, their
biography where we hold a safe one, and their books newest first:

```json
{
  "author": {
    "personName": "Glen Cook",
    "bookCount": 9,
    "bio": { "bioHtml": "<p>Glen Cook grew up in northern California...</p>",
             "sourceIsbn13": "9780000000000", "booksConsidered": 8 },
    "books": [ /* BookListItem[] */ ]
  }
}
```

A name in the catalogue with no biography still gets a page, with `bio: null`;
only a name we do not hold at all is a 404. `GET /authors/search` gains
`hasBio`, so a list can mark who has one without a call per row.

Both are HTML and need the same sanitising as `longDescription`.

## Who a biography belongs to

BDS supply one biography per *book* and no author identifier. A biography is
attached to a contributor only when:

1. the book has exactly one main author (A01) — about 71% of the catalogue;
2. the biography's text names that author's surname — true 94% of the time; and
3. it does **not** name any other contributor.

Rule 3 was added after seeing it happen: manga where one blob covers writer and
illustrator, books with a named translator. It costs 4.1% of attributions and
prevents one person's life story appearing under another's name. Everything
else keeps the biography at book level, where it sits beside the whole book.

`author_bios` holds one row per author, keyed by the normalised name (22% of
contributor rows arrive with doubled spaces), taking the biography from their
most recently published book.

**The collision guard.** Two people share a name; the row is marked
`ambiguous` and nothing is served for that author when their books' biographies
are materially different. Similarity is Jaccard overlap of significant words
**with the shared name excluded** — every biography names its subject, so
leaving the name in made two different people look like one. Measured: same
person reworded scores 0.138 and 0.269; 500 unrelated pairs top out at 0.125.
The threshold is 0.12, deliberately nearer the unrelated population, because
losing a biography is better than publishing the wrong one.

## Keeping it fresh

The nightly delta this was designed around **cannot work**: BDS change ~136,000
records a day and the API pages through only the first 5,000 results of any
query, returning an empty page beyond that with no error. A delta reader would
have reported success nightly while missing ~96% of changes. It was removed,
along with `BDS_DELTA_MAX_PAGES`.

In its place the nightly sweep works in two tiers over **our own** ISBNs:

1. books never asked about — new stock first, walked by `books.id` as a keyset
   rather than an `ORDER BY publication_date` that scans and sorts the table on
   every page;
2. the books asked about longest ago, so the catalogue refreshes on a rotation
   (`BDS_REFRESH_DAYS`, default 30).

Author biographies are rebuilt at the end of the same run, so author pages never
sit a day behind their books.

## Surviving a long run

A backfill is ~11,000 requests over hours, and the trial hit two transient
network failures. Requests now retry through those (1s, 3s, 9s), and a batch
that still fails is logged and skipped — it costs that batch, not the run, and
the next sweep picks those books up. Credentials failures still stop everything,
because they will not fix themselves.

`BDS_CONCURRENCY` (default 1) allows several lookups at once. Measured:

| Concurrency | Rate | Full catalogue |
|---|---|---|
| 1 | 31 books/sec | 9.9 hours |
| 4 | 130 books/sec | 2.3 hours |
| 6 | 142 books/sec | 2.2 hours |

It defaults to 1 because BDS publish no rate limit and none appeared in testing
— "none observed" is not "none".

## Reviews: not the gap-filler we expected

Across the 902 books Nielsen has answered for, Nielsen has a quote for 236 and
BDS for 233 — but they are nearly the same books. BDS fills **9** of Nielsen's
666 gaps. The planned "review gap" priority tier was dropped. BDS reviews are
still stored (they arrive in the same call as the bio, so they are free) and
Nielsen is still preferred when both have one. Biographies, present on 80% of
those same books, are the reason to run this.

## Out of scope

- Splitting a multi-contributor biography into per-person sections.
- Author photographs — BDS carry them on 2 of 95 sample products.
- Feeding biographies into recommendation embeddings; needs its own licence
  answer.

## Verified

1042 unit tests, 22 integration tests against a real Postgres, and the endpoint
contract suite. Live against BDS: 1,000-book sweeps at concurrency 1, 4 and 6;
author and book endpoints checked against real stored data; the author
biography rebuild run over 1,688 books, producing 878 authors.

## Still needed before this is switched on

- Written confirmation from BDS that we may display, store and retain this text.
- The full backfill (2.3 hours at concurrency 4).
- Re-measuring the ambiguity threshold once the full catalogue is loaded, when
  genuine name collisions exist.
