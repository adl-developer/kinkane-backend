# Stop non-fiction and off-format books from diluting fiction recommendations

**Date:** 2026-07-24

## What changed

Onboarding recommendations (`recommendationsService.getRecommendations` /
`computeRecommendations` in
[recommendations.service.ts](../src/services/recommendations.service.ts)) are
built purely from pgvector cosine similarity over `books.embedding` — nothing
hard-constrained the result set to match the genres a user actually picked.
For a `romance/fantasy/mystery` preference, only 27 of the top 100 candidates
carried a Fiction genre tag; the rest were confidently-tagged non-fiction or
children's content that happened to embed close enough to show up anyway.
Nonfiction-only preferences weren't affected (99/100 came back correctly
tagged), so this was a one-directional problem.

Two new helpers bucket the 21 onboarding genre options
(`GENRE_VALUES` in `recommendations.controller.ts`) into fiction /
non-fiction, and add a SQL condition to both query sites that excludes a book
only when it has genre data and every bit of it is on the wrong side:

- `resolveFormatIntent(genres)` — returns `'fiction'` or `'non-fiction'` only
  when every genre the user picked falls unambiguously on one side. A mixed
  selection (or one made entirely of unbucketed genres like poetry) returns
  `null`, meaning no filter is applied rather than guessing at intent.
- `buildFormatCondition(intent)` — the actual `NOT EXISTS(...) OR EXISTS(...)`
  clause, applied in both `getRecommendations` and `computeRecommendations`.

## Non-obvious decisions

- **Untagged books are always kept, in both directions.** ~9.4% of the
  catalog (7,901 of 83,688 books) has zero genre rows at all — including real
  bestsellers like *Beach Read*, *The Da Vinci Code*, and *Maze Runner*.
  Treating "no genre data" as "wrong format" would have filtered out
  genuinely matching books that just aren't tagged yet, which would have
  made the pool worse, not better.
- **Only checks for a top-level Fiction (`F%`) subject code.** Children's
  fiction is tagged under the `Y` top-level in this catalog's Thema scheme,
  so it isn't recognised as fiction by this filter. Not fixed here since
  onboarding's genre list has no children's-fiction option — flagged as a
  gap if that changes.
- **A mixed genre selection (e.g. romance + business) skips the filter
  entirely** rather than picking a side — there's no principled way to guess
  which the user weighted more heavily.

## Out of scope

The ~9.4% zero-genre-tag gap in the catalog itself is a separate ingestion
issue, not addressed here.

## Verification

Ran the actual retrieval query against the real DB, before and after, for a
`romance/fantasy/mystery` preference: confidently-mistagged non-fiction
dropped from ~42/100 to 0/100, and Fiction-tagged coverage nearly doubled
(27 → 50, with the rest falling to legitimately untagged books rather than
wrong-format content). A `self-help/business` preference showed no
regression (already 0 fiction leakage before and after). `tsc --noEmit` and
the existing test suite pass unchanged.
