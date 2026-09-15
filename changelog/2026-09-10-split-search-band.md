# Searching a title and an author together on `GET /api/v1/books`

**Date:** 2026-09-10

## What changed

A search that names a book *and* a person in one string now finds the book.

```
GET /api/v1/books?q=half of a yellow sun adichie
GET /api/v1/books?q=rowling harry potter
GET /api/v1/books?q=things fall apart chinua achebe
```

Before this, none of them worked, and the reason is the same in each case: the whole
string is not a title prefix and it is not a contributor name either. Every cheap tier
matched nothing, so the search fell through to the fuzzy title pool — the slowest query the
endpoint issues — and ranked near-misses against a string that was never one title.

v1 only. v2 makes the caller name the side it wants with `type`, so a v2 search has already
declared the query to be all title or all name; there is nothing left to split. Nothing
about v2 changes, and its 400 on `type=all` still stands.

## Where it sits

A new band in the existing ladder, between the exact band and the fuzzy one:

| band | matches |
|------|---------|
| exact | title prefix, or a contributor's name prefix in any role |
| **split** | **a contributor's name prefix *and* leftover query words in the title** |
| broad | fuzzy title, fuzzy name |

The placement is the whole performance argument, and it is worth being explicit about:
this band is not added on top of the search, it is inserted into the gap the search already
fell into. It is entered on exactly the condition that used to send a query to the fuzzy
pool — the exact band matched nothing at all, by title or by name, anywhere. A query the
cheap tiers answer never reaches it and pays nothing for it.

Nor does a query that cannot split. A single token produces no candidates, so single-word
typos — the case the fuzzy pool legitimately exists for — reach it without a wasted round
trip on the way. That mattered enough to pin as a test.

So on the queries it touches it should be *cheaper* than what it replaces, and everywhere
else it is free.

## How the split is decided

It isn't guessed. That is the central design decision here and it went the other way first.

`lib/search-split.ts` proposes every contiguous way the tokens could divide into a name run
at one end and title words at the other, and stops there. Which reading is right is decided
in SQL, per book, by scoring each proposal against the catalogue and keeping the best one
for each book.

"harry potter rowling" is why. Both "harry" and "rowling" match real contributors, so any
rule that picks one winner up front has to break that tie with no evidence behind it. Score
per book and the evidence decides: only under the "rowling" reading do the leftover words
"harry" and "potter" appear in that author's titles. The join is the same either way, so
the better answer is also the free one.

The probe itself is one statement:

- **Two index arms per candidate.** A plain-prefix arm on `lower(normalised person_name)
  LIKE 'run%'`, which `idx_book_contributors_name_lower_pattern` serves as a range scan, and
  a word-prefix arm on the trigram GIN. The second is not optional — most readers type a
  bare surname, and "adichie" is a prefix of nothing.
- **Every arm capped independently.** One cap over the union would let a popular fragment
  produce its whole match set before the merge could discard it, which is the unbounded-work
  shape `SEARCH_COUNT_CAP` and `AUTHOR_MATCH_LIMIT` both exist to prevent.
- **At least one leftover word must appear in the title.** Without it, the run "harry" pulls
  in every book by every contributor named Harry — that is the name half alone, which the
  author branch already covers and the exact band already ruled out, and it would bury the
  books the reader asked for underneath.
- **Ranked by how much of the query the reading accounts for**: the proportion of leftover
  words found in the title first, then the length of the name run, then A01 above other
  roles. Packed into one integer so `MAX()` takes the best *interpretation* rather than
  mixing keys from two different readings of the query.

## The non-obvious decisions

**Stopwords are dropped from the title test, not from the query.** `title ILIKE '%a%'` is
true for almost the whole catalogue, so counting it as evidence scores every book by the
right author identically and hands the ranking to the alphabet. "half of a yellow sun
adichie" tests `half`, `yellow`, `sun`: the real book scores three of three, and an
unrelated book by the same author scores nothing and leaves the band entirely.

**The band is materialised as a ranked id list, not queried per page.** One capped list
serves three purposes at once — the rows are a slice of it, its length is the exact total,
and it caches, so every later page of that search is a Redis read. Page stability is the
reason it had to be one of these rather than a per-page ranking: the score ties heavily,
since most matching books match the same proportion of leftover words, and a re-ranked
wider `LIMIT` per page is the resampling hazard `rankAuthorMatches` and `rankBroadPool` both
document.

**A split search deliberately does not write the shared count entry.** That entry feeds
`exactBandCount` on the next page, where it means "the cheap tiers matched this much" — and
the reason this search reached the split band is that they matched nothing. Caching a split
total there would make page 2 read a non-empty exact band, drop back to the fuzzy tier, and
answer the same query a different way. The list has its own entry under `SPLIT_TTL`, so
nothing is recomputed per page regardless. This is pinned by a test, and it is the subtlest
thing in the change.

**The band is entered only when the exact band is empty, not when it merely runs out.** A
query the cheap tiers answered on page 1 keeps the behaviour it has all the way down, rather
than changing its mind about what kind of query it is at page 3.

**An empty band falls through rather than answering empty.** Nothing matched a name and a
leftover title word together is an absence of an answer, not an answer, so the search lands
where it would have landed without the band.

## Costs

No new index, no schema change, nothing for the ingester to maintain. It reuses the two
contributor-name indexes that already exist for author search. The only new storage is one
capped id list per distinct split search in Redis, a few kilobytes at most.

The latency estimate for the probe is by analogy to the existing cheap tier rather than
measured: every arm is the same indexed range scan shape, and more selective than the title
prefix that measured at 15.4ms. **That analogy is the one assumption worth checking against
production before trusting the numbers.** If any arm is not using the pattern index, the
query degrades to a sequential scan over `book_contributors`, which is the exact cost this
band exists to avoid. An `EXPLAIN` on the rendered probe is the first thing to run.

## Known imprecision

A search whose rows are cached while its count entry is not — which happens when a count
probe previously timed out — can have its caption computed from the split band while its
rows came from the fuzzy tier. `hasMore` comes from the cached page, so pagination is
unaffected and only the number is off. Left as is rather than guarded, because the guard
costs the accurate caption in the common case to fix a rare one.

Contributor names are matched with `lower()` and `LIKE`, and the database ctype is `C`, so
both are ASCII-only. An accented name is reachable only when the query reproduces the
accent. That is pre-existing behaviour shared with every other name tier, not something this
band introduces, but it applies here too.

The typeahead, `GET /books/search`, is untouched. It blends both sides into eight
suggestions with no pagination and no total, and a reader three characters in has not yet
said what they are looking for — aligning it is a separate decision.

## How it was verified

`npx tsc --noEmit` clean. Full suite at 801 passing, with the same four pre-existing
failures as the parent commit (`subscription-pricing` needs Stripe env config, plus one in
`referral-copy`) — confirmed identical by stashing the change and re-running.

`src/__tests__/search-split.test.ts` is new and covers candidate generation directly: the
queries that must produce nothing, the readings that must survive, the width cap that bounds
the probe, and the stopword rules in both directions.

`src/__tests__/search-count-probes.test.ts` gains a block for the band, at the level that
file already works at — asserting on the SQL issued, because none of this is visible in the
returned rows. It pins that the band is skipped when a cheap tier matched, skipped for a
query that cannot split, never run on either side of v2, bounded per arm, kept in the
expression shape the pattern index can serve, requires a title-word hit, does not write the
shared count entry, and falls through to the fuzzy tier when empty.

Two of those were mutation-checked rather than assumed: caching the split total and dropping
the title-hit requirement each fail exactly the test written for them.

The generated SQL was rendered through drizzle's dialect and read end to end, since the
database was not reachable from this machine to run it. **It has not been executed against a
real catalogue.** That is the gap: the shape is right and the plan is unverified.
