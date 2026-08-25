# Stop an exact author match being lost to the fuzzy search tier

**Date:** 2026-08-25

## What changed

Searching `/books?q=` for an author's full name returned unrelated books
instead of that author's. Reported for "peace adzo medie", whose one book
(*His Only Wife*) is in the catalogue and was not in the results.

## Why it happened

Book search runs a title branch and an author branch and merges them. Each
branch has tiers, cheapest first — the cheap author tier is an index-backed
prefix match on the contributor's name, the broad one a trigram/FTS scan over
the whole contributor table.

The author branch's tier was bound to the *title* branch's: if the title
branch fell through to broad, the author branch went broad too. Those two
tiers measure different things, and a query can be hard for one and trivial
for the other. "peace adzo medie" matches no title prefix at all, so the title
branch fell to broad — but it is an exact prefix of a `person_name`, which the
cheap tier answers from the name index in microseconds.

Escalating in lockstep sent that query straight to the fuzzy name scan. On the
production catalogue (~2M books) that exceeded the broad tier's 5s budget, was
cancelled, and the branch returned nothing — so the one genuinely correct
result was the one dropped, and the page came back as title near-misses only.

The typeahead (`/books/search`) never had the bug, because it has always tried
its cheap author tier first. That was the diagnostic: on production the
typeahead returned *His Only Wife* as its first result while the list endpoint
returned none of the author's books at all.

## The fix

The author branch now tries its cheap tier on its own merits regardless of
which tier the title branch landed on, and escalates to the fuzzy tier only
when cheap matched nothing. The escalation keeps the time budget and the
timeout handling it already had — that path can still overrun, and running it
unguarded would trade one failure mode for a worse one.

## Not in scope

Books whose only credited contributor is an editor, translator or illustrator
(ONIX roles other than `A01`) are still unreachable by name search — about one
in five books in the catalogue. That is a separate change.

## How it was verified

Reproduced against production, where the query returned five unrelated titles
in 6.2s — the 5s budget plus the title branch. Locally (83k books) the budget
is never reached and the bug does not appear, which is why it needed the
production catalogue to see at all.

Three regression tests were added to `search-count-probes.test.ts`, which mocks
the database and asserts on the SQL issued — the right level here, because the
difference is invisible in the returned rows: both tiers return author matches,
and the broken one returned none only at a scale no unit test reproduces. They
pin that the cheap tier is attempted on a broad-tier search, that it is asked
before the fuzzy one, and that the escalation stays inside the time budget. All
three were confirmed to fail against the previous behaviour.
