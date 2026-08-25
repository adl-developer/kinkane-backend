# Stop search pages repeating books from earlier pages

**Date:** 2026-08-25

## What changed

Paginating a book search could return a book that had already appeared on an
earlier page. Two independent causes, both fixed here.

## Cause 1: the tier changed partway through pagination

`list()` picks a ranking tier per request. The ladder tested the *title* match
counts — which is deliberate and documented — but the tier's output is titles
merged with name matches from the author branch. So the ladder could abandon a
tier while it still had rows to give, drop to the broad tier, and apply the raw
offset inside a completely different ordering over a different set.

Measured on `q="roald dahl"`:

    fastCount  =  9   (titles starting "Roald Dahl")
    cheapCount = 13   (+ word-prefix titles)
    exact band = 40   (the tier's real supply, once names are counted)

    offset  0 -> 13 > 0  -> cheap
    offset 10 -> 13 > 10 -> cheap
    offset 20 -> 13 > 20 -> BROAD, with 20 rows of supply unspent

Because the broad tier leads with author rows where the cheap tier leads with
title rows, offset 20 landed near the top of a different list, and page 3
reprinted page 1 almost exactly.

The ladder now tests the size of the whole exact band — `exactBandCount`, which
already existed in this function for the fuzzy-skip decision. Since it is
`max(fastCount, cheapCount, blendedCount)` this is a strict widening: the tier
is held while *either* branch still has supply.

## Cause 2: the title orderings were not total

`buildFastTitlePrefixOrderBy` ordered by `lower(title)` alone, and
`buildTitlePrefixOrderBy` by `(prefix CASE, title)`. Neither breaks every tie.
Each page fetches a larger LIMIT than the last, so among tied rows Postgres was
free to return a different arbitrary subset each time, and the subsets
overlapped.

Editions of one book share a title exactly, so ties are common rather than
exotic — this accounted for every remaining repeat on `q="harry"` once cause 1
was fixed. Both orderings now end in `books.id`, which is what the author
branch's ranking has always done and documents the reason for.

The fast tier loses its index-only sort to this, since `lower(title)` alone can
be walked straight off `idx_books_title_lower_pattern`. Measured, it does not
move the timings: the tier's match set is already bounded by the page, so the
extra sort is over tens of rows.

## Measured effect

Five pages of ten, at offsets 0/10/20/30/40, counting ids that appear on more
than one page. Cache cleared between runs — an early comparison was invalid
because the second run was reading rows the first had cached.

    query          before  after      5 pages, before -> after
    roald dahl         10      0      1077ms -> 1016ms
    jane austen         2      0       823ms ->  820ms
    harry               3      0       822ms ->  811ms
    hunt                1      1      1524ms -> 1109ms
    catherine           0      0
    adiche              0      0
    the                 0      0

## What is still open

`q="hunt"` still repeats one book. `fastCount` is 23, so at offset 20 the
ladder moves from the fast tier to the cheap tier — a different ordering again,
and the same class of bug at a different boundary. Fixing it properly means
rebasing the offset when crossing a tier boundary and excluding ids the
previous tier already returned.

That mechanism already exists for `dedupe=true`: the opaque `cursor` carrying
`{o, t}` with `nextCursor`, built precisely so a title cannot appear on two
pages. Generalising it to all searches is the complete fix, and is a public API
change — clients would paginate on `nextCursor` rather than `offset`. Left as
its own piece of work.

## How it was verified

The table above, plus regression tests in `search-count-probes.test.ts`. Those
needed a harness change first: row fetches go through `db.select()` rather than
`db.execute()`, so their WHERE and ORDER BY never reached the `issued` list the
existing tests assert on, and the first versions of both tests passed against
the unfixed code. The mock now records them. Each test was then confirmed to
fail when its own fix — and only its own fix — was reverted.
