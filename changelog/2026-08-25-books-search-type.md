# `GET /books?q=` searches titles or authors, not both

> **Superseded on 2026-08-27.** This landed on `GET /api/v1/books`, changing what
> existing clients got from a plain `?q=`. It has since been moved to
> `GET /api/v2/books` and v1 restored to blending both sides — see
> [2026-08-27-books-v2-search-type.md](2026-08-27-books-v2-search-type.md). The
> design below is unchanged and still describes v2 exactly; only the URL it lives
> at, and the "Behaviour worth knowing" note about breaking existing clients, are
> out of date.


`GET /books?q=` used to match book titles *and* contributor names in a single
request, blending the two into one ranked page. It no longer does. A new
`type` parameter picks the side:

```
GET /books?q=hunt              # titles (the default)
GET /books?q=hunt&type=title   # titles, explicitly
GET /books?q=hunt&type=author  # contributor names
```

There is no combined mode. `type=all` is rejected with a 400 rather than
quietly served as a title search.

## Why

The blended page was always a compromise the architecture had to work around
rather than something it supported. The two sides were already fetched as
separate queries against separate indexes — they had to be, because the title
branch's speed comes entirely from its `ORDER BY` matching an index's own
ordering, and no single index can rank a title match against a name match. A
blended query made Postgres sort the whole candidate set: roughly 322,000 rows
for a prefix like "the".

So the results were merged in memory afterwards, and merging needed rules that
had no principled answer — only a tuned one. Which side leads? Titles, except
when the title branch had fallen through to fuzzy matching, in which case an
exact name match is a better answer than a fuzzy title one, so names lead.
That rule existed because "Roderick Hunt" returned *Life of Sir Roderick I.
Murchison* above the author's own books.

Making the caller say which side it wants removes the question. A UI that
genuinely wants both now runs two requests and shows two lists, which is the
honest presentation anyway — the blended page was always asserting a ranking
between two things that have no common scale.

## What this buys

- **One query instead of two** per search, plus no merge.
- **The blended count probe is gone.** It existed only to count "books matched
  by either side" for the `total` caption, and it was the expensive probe: a
  bounded union across both branches on every uncached search. Each side now
  counts itself.
- **An author search skips the title tier ladder entirely.** It never runs the
  fast/cheap title probes, and it can never reach the fuzzy title pool — the
  most expensive query a search can issue.
- **The tier ladder and the count now measure the same set.** They previously
  did not: the probes counted titles, but the page contained titles merged with
  name matches, so the ladder could abandon a tier that still had rows. That
  mismatch is what made `q="roald dahl"` reprint page 1 as page 3.

## Behaviour worth knowing

**This changes what an existing client gets.** A user typing an author's name
into a search box wired to `GET /books?q=` now gets title matches only —
possibly fuzzy near-misses, possibly nothing — where they previously got that
author's books. Any client that wants the old behaviour has to issue the second
request itself. This was a deliberate call, not an oversight.

`type=author` matches **any** contributor, with ONIX A01 authors ranked above
editors, translators and illustrators. Searching an editor by name still finds
the volume they edited; it just sits below books actually written by anyone of
that name. This preserves the existing ranking rule rather than narrowing to
A01, so a search for a translator or editor is not silently empty.

`type` is accepted and inert when `q` is absent — a filter-only browse matches
nothing textual. Rejecting it would break a UI that keeps one query-string
builder for both the browse and the search.

Each side keeps its own escalation ladder, and they are deliberately not run in
lockstep:

- titles: fast prefix → cheap word-prefix → broad (trigram/FTS over a bounded pool)
- names: cheap name-prefix → broad (trigram/FTS over `book_contributors`)

An author search escalates only when the cheap tier matched no name at all. An
over-budget fuzzy name scan returns no name matches rather than failing the
request.

## Caches

Both cache prefixes are bumped — rows to `v6`, counts to `v5`. The new
`searchType` field changes every key hash on its own, so the bump is
belt-and-braces, but a cached blended page is exactly the kind of thing that
should not outlive the deploy.

## Explicitly out of scope

The typeahead endpoint, `GET /books/search`, is **unchanged**. It still accepts
`type=all|title|author` and still defaults to blending both sides. A dropdown
of eight suggestions is a different problem from a paginated result page: it
has no pagination to keep stable, no `total` to caption, and a user who has
typed three characters genuinely has not said what they are looking for yet.
Aligning the two is a separate decision, not a consequence of this one.

## Verified

`npx tsc --noEmit` clean. Full suite at 394 passing (3 pre-existing
`subscription-pricing` failures, unrelated — they need Stripe env config).

`src/__tests__/search-count-probes.test.ts` was reworked: the three blended-probe
tests became author-probe tests, and the probe-gating tests now assert the
separation directly — a title search issues no query against `book_contributors`,
and an author search issues no title count probe and never reaches the fuzzy
title pool. The `OR`-shape guard was kept even though the blended probe that
motivated it is gone: the shape is what caused the original 9.5s regression, and
nothing about `type` prevents someone reintroducing it.

`src/__tests__/search-type.test.ts` is new, covering the parameter contract at
the controller: the default, both explicit values, `type=all` and unknown values
rejected as 400, and the inert-without-`q` case.
