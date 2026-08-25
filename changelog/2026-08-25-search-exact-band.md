# Rank search by how well it matched, before where it matched

**Date:** 2026-08-25

## What changed

Book search now resolves `/books?q=` as a single ladder, in this order:

| band | tier | match |
|------|------|-------|
| exact | 0 | title prefix |
|       | 1 | author (A01) name prefix |
|       | 2 | any other contributor's name prefix |
| broad | 3 | fuzzy title |
|       | 4 | fuzzy name, any role |

Two properties matter more than the list itself.

**Match quality is the outer key, and where it matched is the inner one.** An
exact prefix hit on an editor beats a fuzzy near-miss on an author. Someone
typing "Catherine Eschle" wants the volume she edited, not a fuzzy slide to
"Catherine Dawson" — which is what production returned before this.

**The broad band is only entered when the exact band is empty.** Not "when the
title branch found nothing" — when *nothing* matched exactly, by title or by
any name. A query that an exact name answers no longer pays for the fuzzy pool
at all.

## Why

Two reports, one underlying shape. Searching "peace adzo medie" returned five
unrelated books; searching "Catherine Eschle" returned books by Catherine
Dawson. In both cases the correct book was in the catalogue.

The author side was already fixed to stop losing exact matches to its own
timeout (see `2026-08-25-author-search-tier.md`). This is the other half: the
*title* side could still crowd out an exact name match, because the two sides
were ranked independently and merged, with no notion that an exact match on
either beats a fuzzy match on the other.

Eschle was a different failure again — she is credited `B01` (editor), and
name search filtered to `A01` outright. About one book in five has no `A01`
contributor at all: edited collections, translated works, illustrated
children's books. All were unreachable by name at any spelling.

## The non-obvious decisions

**Roles are ranked, not filtered.** The original A01-only filter was
deliberate, with a test asserting it. It is right as a ranking rule and wrong
as a filter, so the predicate became a tier tag instead. That test was
rewritten to pin the ranking, and the reasoning recorded in its place.

**`role <> 'A01'` rather than an allow-list.** The tier ranking already keeps
editors, translators and illustrators below authors, so naming them buys
nothing — and an allow-list would silently drop whichever ONIX role a future
Gardners feed introduces, which is the failure this change exists to remove.

**The band decision is count-driven, not row-driven.** "Did the exact band
match anything" is answered from the count probes, and folds in the cached
total, because a paginating request skips the blended probe. Deriving it from
what the fetch returned would let page 2 drop to the fuzzy tier that page 1
skipped — the same query answered two different ways on two pages.

**The name indexes were widened off `role = 'A01'`.** They were partial on
that predicate, so any role-widened query would have seq-scanned
`book_contributors` — the exact cost the previous fix existed to remove. The
role predicate now lives only in the query, where the name match is selective
enough that rechecking role against the heap is cheap. Keeping the A01
partials alongside the widened ones was rejected: a marginally tighter scan
for common name fragments, against four indexes to maintain on a table that
ingestion bulk loads into.

## What this changes about results

Exact-name searches return **fewer but precise** results. "peace adzo medie"
now returns one book — the right one — where it previously returned five, four
of which were noise. `total` and `hasMore` agree with the rows rather than
counting padding.

## Not in scope

Contributor names ingested with doubled internal whitespace (`Catherine
Eschle` is stored with two spaces, as are `David  Peace` and `Karl E.  Peace`)
still only match when the query reproduces the doubled space. Normalising that
is an ingestion-side change and is not addressed here.

## How it was verified

Against the local catalogue: "peace adzo medie" returns *His Only Wife* alone
(total 1, `hasMore` false); "Catherine Eschle" returns both editions of
*Feminism and Protest Camps*; typos and nonsense queries still reach the fuzzy
tier and return the same results as before; the fuzzy pool is skipped for the
first two, cutting them from ~140ms to well under it even at this scale.

"Jane Austen" was checked specifically, because a strict cascade would have
been wrong there: her name is also a title prefix, and stopping at the first
non-empty stage would have returned tie-in titles and boxed sets while hiding
the 52 books she wrote. Because the bands merge internally rather than
short-circuiting, her own books still appear on page one.

Regression tests were added to `search-count-probes.test.ts`, which mocks the
database and asserts on the SQL issued — the right level, because the fuzzy
pool being skipped is invisible in the returned rows. They pin that the pool
is skipped on an exact name match, that it still runs when nothing matched
exactly, and that a cached count does not make a later page decide
differently. All were confirmed to fail against the previous behaviour.
