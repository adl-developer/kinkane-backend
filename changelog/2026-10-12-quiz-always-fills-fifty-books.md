# Quiz recommendations always fill to 50 books

**Date:** 2026-10-12

## What changed

The quiz recommendation list (`POST /recommendations` for guests and
`PATCH /recommendations/refresh?includeRecommendations=true` for signed-in
readers) now always returns 50 books, as long as the shop has 50 in-stock books
the reader hasn't already shelved or rejected. Before, 50 was only an upper limit. A reader with
unusual answers, or a long-time reader who had shelved and swiped away a lot,
could get a short list or even an empty one.

The list is filled in five tiers, always ranked in this order:

| tier     | what it is                                                         |
|----------|--------------------------------------------------------------------|
| strict   | books within `RECO_SIMILARITY_MAX`, best edition of each work      |
| backfill | the next-nearest books, out to `RECO_BACKFILL_MAX`                 |
| reach    | the next-nearest books beyond that, at any distance                |
| genre    | in-stock books in the reader's quiz genres, newest first           |
| filler   | popular in-stock books, ignoring the reader's format and dislikes  |

The response shape is unchanged: `{ bookId, rank, explanation }` per book.
Filler books are not marked. They look like any other recommendation, AI
explanation included.

## Why lists came back short

There were three causes, and each one gets its own fix:

1. **A distance limit on the search.** Only books within cosine distance 0.7 of
   the reader's taste could be returned. A reader whose answers pointed
   somewhere sparse simply had fewer than 50 books inside that limit. A
   deliberately off-cluster test vector found two in the whole catalogue.
   **Fix:** the search no longer has a distance limit. It returns the nearest
   books at whatever distance they are, and the old 0.7 cutoff now only labels
   the backfill/reach split in the logs. This also makes the sparse case
   *faster*: with the limit in place, a search that could not find enough books
   kept scanning the index up to its tuple cap before giving up.
2. **Edition collapsing after the search.** The search reads 300 rows and then
   collapses editions into one book per work, which can leave fewer than 50.
   **Fix:** when a full pool of 300 still leaves the list short, the search
   runs once more with a pool of 500 and the tiers are recomputed from scratch.
   500 is the existing ceiling on `RECO_FETCH_POOL`, the largest pool already
   reviewed as affordable. It is one wider pass rather than further pages:
   paging with OFFSET re-walks every row before the page, so pages 2 and 3
   would have cost 600 + 900 extra rows, in separate transactions that could
   disagree about which books qualify.
3. **The index scan giving up early.** pgvector stops an iterative scan after
   visiting 20,000 index entries by default. With only ~26% of embedded books
   in stock, plus format, dislike and shelf filters, a heavily filtered search
   could stop before finding 300 rows. The scan also stops when its held
   candidates outgrow `work_mem` × `hnsw.scan_mem_multiplier`, which at a 4MB
   `work_mem` can bind first. **Fix:** `hnsw.max_scan_tuples` is raised to
   100,000 and `hnsw.scan_mem_multiplier` to 4, for the recommendation search
   only (`SET LOCAL`, and only on pgvector 0.8+ where both settings exist).

When the vector search has nothing more to give, the **genre fallback** tops the
list up from in-stock books tagged with the reader's quiz genres, newest first.
The quiz labels map to Thema subject-code prefixes (crime → `FF`/`FH`, romance
→ `FR`, travel → `WT`, …). The mapping lives in the same table as each genre's
fiction/non-fiction side, so a new quiz chip is added in one place. The fallback
narrows only when *every* chosen genre maps; a mix like romance + non-fiction
is not narrowed at all, rather than quietly becoming romance-only. If the genre
match is still not enough, the rest comes from any book that passes the
reader's rules. This tier does not need an embedding, so it also reaches books
still waiting on the embedding backfill.

The fallback reads in batches of four rows per missing book. It keeps reading
until the list is full or the catalogue runs out, because one batch can be
mostly new editions of the same few works. The whole fallback shares a
3-second time budget. It runs exactly when the filters are most restrictive,
ordered newest-first across the whole catalogue, so on 2M books it could walk a
long way. When the budget runs out it stops, logs
`Recommendation genre fallback timed out`, and returns what it has. A list a few
books short is a better outcome than a quiz that hangs.

## The filler

When everything above still leaves the list short, the rest is padded with
popular in-stock books. That happens when the catalogue has fewer than 50 books
matching the reader's answers, or when the genre fallback ran out of time.
"Popular" means reader activity first: the same 30-day trending score as the
trending feed. After that comes Gardners stock depth, then newest. Deep stock is
the distributor's own bet on what sells, and it's always available, whereas the
trending signal is thin until the app has many readers. The filler reads in
batches until the list is full. It has no time budget, because it's what makes
the list reach 50. Instead it stops after 10 batches, as a guard against a loop
that never makes progress.

## What is never relaxed

The filler drops two of the reader's rules: their fiction/non-fiction format and
their dislikes (500+ pages, series). It never drops these:

- **In stock** and not withdrawn. Every card on the quiz is a book we're
  inviting the reader to buy.
- **Never a book the reader named, shelved or swiped away**, nor another edition
  of one. The quiz promises not to show a book twice.
- **Has a named author**, which every card and the edition-collapsing rely on.

No book ever appears twice, and every book is a different work. The rules live
in `buildFillerConditions`; `buildBaseConditions` is those rules plus format and
dislikes, so the two can't drift apart.

A list can therefore come back short only if the shop has fewer than 50 in-stock
books the reader hasn't already shelved or rejected. In that case it returns what
exists rather than repeating books.

## Cache

Cached lists carry a new `fill` version in their cache key, so every existing
entry is retired on deploy. Without that, short lists already cached for 48
hours would keep being served for up to two days. The first quiz for each set of
answers after deploy will recompute (one Gemini explanation call, as on any
cache miss).

A list that needed filler, or that still came back short, is cached for 1 hour
instead of 48. Filler can stand in for a genre fallback that merely ran out of
time, so the next reader with those answers gets a fresh attempt at real
matches. Before, only lists under 10 books got the short lease.

`RECO_BACKFILL_MAX` has been taken out of the cache fingerprint. It no longer
changes which books are returned, only how the top-up is labelled in the logs,
so changing it must not flush the cache.

## Logging

Whenever a list needs the reach, genre or filler tiers, the server logs
`Recommendation list topped up past the backfill cutoff` with the count per
tier, so `filler` shows how often padding happens. A list that still could not
be filled logs a separate warning, `Recommendation list could not be filled to
target`. The `Recommendation list came back short` warning now fires for any
list below 50, not just below 10.

## Out of scope

- **Re-measuring the scan caps and the fallback timeout on production.**
  100,000 tuples, a 4× memory multiplier and 1.5s were chosen, not measured
  against the 1.1M-book catalogue. They only cost anything on the sparse path.
- **A smarter ranking for the genre fallback than newest first.** It is a last
  resort, and on the local catalogue it never fired: the vector search filled
  every list tested, including off-cluster ones.
- **Allowing order-in books.** That would widen the pool a lot, but showing only
  in-stock books in recommendation feeds was a deliberate product decision
  (2026-10-05).

## How it was verified

- New integration test (`recommendation-fill.integration.test.ts`, against a
  real pgvector database, with the pool lowered to 50). The catalogue has 3 strict works (one in two
  editions), 20 far-away books and 50 books with no embedding. The list fills to
  exactly 50 in tier order. Out-of-stock and rejected books never appear, and
  the two editions collapse to one book. Crime-tagged fallback books rank ahead
  of newer untagged ones. A second case has five works in twelve editions each
  fill the first pool. It checks that the wide pass finds 45 further close
  matches in exact distance order. With the wide pass disabled this case fails:
  the genre fallback finds the same books but in a different order.
  A fourth case makes the newest 200 fallback books editions of just four works,
  so the first batch alone would return 4 books. It checks that the next batch
  reaches the backlist. This case fails if the fallback stops after one batch.
  With the time budget set to 1ms, a budget overrun returns a short list and a
  warning rather than an error. A fifth case has only three matching works. It
  checks the list pads to 50 with filler: real matches first, then the book with
  reader activity, then the deep-stock book. It also checks the rejected book and
  the out-of-stock book never appear. This case fails with the filler switched
  off. A last case confines even the filler to three books and checks the list
  returns those three rather than repeating them.
- Filler alone, on the 83k-book local catalogue with matching forced to find
  nothing: 50 books in 1.1s, or 0.3s with 3,000 books excluded.
- Stress run on the 83k-book local catalogue: 180 readers with on-taste, random
  and opposite-taste vectors, 1–3 genres, both dislikes and up to 3,000 excluded
  books. Every one got 50 (median 0.16s, 95th percentile 0.6s, slowest 4.2s).
- Static guards in `vector-recall.test.ts`: the vector search has no distance
  bound but still requires an embedding (an unembedded book would otherwise
  sort as a perfect match). The wide pass runs only when a full pool comes back
  short, never pages with OFFSET, and stays within the `RECO_FETCH_POOL`
  ceiling. Both scan caps are set only alongside the iterative scan.
- Timed on the 83k-book local catalogue: a normal vector returns 50 in ~0.8s
  (unchanged path), an off-cluster vector 50 in ~1.3s cold. The genre fallback
  query on its own takes 160–510ms.
