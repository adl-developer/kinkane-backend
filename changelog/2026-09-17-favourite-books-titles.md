# The books you loved now search on the books, not their titles

## What changed

The recommendation search builds a query vector out of several "lanes" — one
per thing the reader told us: the feelings they picked, the genres, the books
they marked Just Right, the things they want to avoid. Each lane is embedded
separately and combined under configurable weights, so a lane's influence is a
number somebody chose rather than however much text it happened to contribute.

The books lane was the weakest of them, and not for a reason anyone had
decided. It was built by writing a sentence —

    Books I have enjoyed: "The River Is Waiting" by Wally Lamb; ...

— and asking Gemini to embed it. That is an embedding of some proper nouns. If
the model knows the book well it lands somewhere sensible; for most of a
1M-book UK catalogue it carries almost nothing about what the book is actually
like. So the strongest signal a reader gives us — here are five books I loved —
was reaching the search as a list of names.

Every book in the catalogue already has an embedding, built at ingest from its
title, subtitle, author, subjects and description, in the same 768-dimension
space the search runs in. Behind `RECO_BOOKS_FROM_EMBEDDINGS`, the books lane
now uses those vectors instead: each one normalised, then averaged into a
single centroid — a fingerprint of what the reader's books have in common.

## Why this way

**Averaging normalised vectors, not raw ones.** A book with a long blurb embeds
to a longer vector than one with a two-line description. Averaging raw would
let the wordier book speak for the reader's taste, which is the same accidental
weighting the lanes exist to remove. Every book gets one equal vote.

**Falling back to the titles rather than dropping the lane.** A book the
embedding backfill hasn't reached yet has no vector. Those books are skipped
and the rest still form the fingerprint; only when *none* of the named books
are embedded does the lane go back to the sentence. Dropping the lane entirely
would quietly remove the reader's books from their own search.

**A separate flag, defaulted off.** Weighting itself already ships dark behind
`RECO_WEIGHTING_ENABLED`, and this is a second, independent change to what the
search actually looks for. Keeping them separate means an environment can
enable weighting, tune the numbers, and then change what the books lane means
as its own step — rather than discovering both at once and not knowing which
moved the results.

**The cache key distinguishes them.** `retrievalFingerprint` now carries
`bvec`/`btitle`. An entry written with the titles lane is the answer to a
different search, not a stale answer to this one, so it is not reused. Without
this the flag would appear to do nothing for 48 hours — the same "I changed it
and nothing happened" failure the fingerprint was added for.

**Cheaper, not more expensive.** The stored vectors need no embedding call, so
on this path the request to Gemini gets shorter by one clause.

## What was left out

**Multi-modal taste.** A centroid is the honest simple thing, and it has a
known failure: a reader whose picks are literary fiction *and* cosy crime
averages to a point that is neither, and the nearest books to that point may
resemble nothing they named. Fixing it means scoring against the best-matching
liked book rather than the centre, or clustering the picks and running a query
per cluster with slots allocated between them. Both change the shape of the
search, so they are their own change. `averageUnitVectors` documents the limit
where someone will find it.

**Everything else in the weighting document** — themes and tone as separate
scored facets, review signals, the retrieval/re-rank split, slate diversity,
recency. None of those were worth tuning while the books lane was reading
titles.

## How it was verified

**Measured against the local catalogue** (83,688 books, all embedded). One
reader, five literary novels about family and grief, with the switch off and
then on:

| | titles lane | stored embeddings |
|---|---|---|
| query's distance to the reader's own books | 0.409 | 0.177 |
| nearest result | 0.361 | 0.170 |
| top results | The Book Thief, White Fragility, Becoming, Beach Read | Albion, Soon Come, Bad Cree, All the Things We Don't Talk About |

The titles column is a generic bestseller list — the books that sit near any
vaguely literary query. The embeddings column is books that share the reader's
taste.

**Unit tests.** `averageUnitVectors` is tested directly: equal votes regardless
of vector length, a centroid between its inputs, unit output, unusable vectors
skipped, null when books cancel out, a throw on mixed dimensions.
`preference-lanes.test.ts` runs the real lane-building code with Gemini stubbed
and checks behaviour rather than source text: the books lane is the centre of
the named books with no embedding call, a book with a longer vector gets no more
say, only the lanes that are still words reach Gemini, an unembedded book is
left out rather than blocking, and the titles sentence returns when no book is
embedded or the switch is off. `reco-config.test.ts` checks the switch defaults
to off. Each was confirmed to fail when the behaviour it covers is broken on
purpose. Full suite green (856 tests), typecheck clean.

**Probe scripts.** `scripts/reco-weight-probe.ts` produced the table above.
Its books are looked up by title and author through `scripts/probe-support.ts`
rather than by id, since ids differ between databases.
