# `type` moves to `GET /api/v2/books`; v1 goes back to searching both sides

The `type` parameter added on 2026-08-25 changed what an existing client got from
`GET /books?q=`. That was a deliberate call at the time, and it was the wrong
place to make it: the endpoint clients were already pointed at quietly started
answering a different question.

The behaviour is unchanged — it just has its own URL now.

```
GET /api/v1/books?q=hunt                # titles AND author names, merged (as before 08-25)
GET /api/v1/books?q=hunt&type=title     # 400
GET /api/v2/books?q=hunt                # titles (the default)
GET /api/v2/books?q=hunt&type=title     # titles, explicitly
GET /api/v2/books?q=hunt&type=author    # contributor names
GET /api/v2/books?q=hunt&type=all       # 400 — there is still no combined mode
```

## What each version is

**v1 is frozen.** It is exactly what the endpoint did before 2026-08-25: `q`
matches book titles *and* contributor names, the two branches are merged
title-first, and an exact name match leads once the title branch has fallen
through to fuzzy matching. Every criticism in the 08-25 note still applies to it
and none of them will be fixed there. That is the point — the reason to have two
versions is so that the first one stops moving.

**v2 is the 08-25 implementation, unchanged**, reached at a URL that says so. One
query per search instead of two plus a merge, no blended count probe, and an
author search that never touches the title tier ladder or the fuzzy title pool.

Nothing else is versioned. `/api/v2` mounts `/books` and nothing more: there is
no `/api/v2/books/search`, no `/api/v2/books/{id}`, no `/api/v2/cart`. A v2 route
identical to its v1 twin would be a second URL to keep in step for no benefit,
and the first time the two drifted it would be by accident rather than by
decision. Clients move their catalogue search to v2 and leave every other call
where it is.

## v1 rejects `type` rather than ignoring it

`GET /api/v1/books?type=anything` is a 400 naming v2, including `type=title`.

Ignoring it would have been the quieter option and the worse one. A client that
adopted `type` after 08-25 would keep receiving blended pages with no indication
that the parameter it is sending does nothing, and the symptom — an author search
answered with title matches — reads as a ranking bug rather than a wrong URL.
`type=title` is rejected along with the rest for the same reason: v1 still folds
in author matches, so accepting it would mean accepting the parameter and
disobeying it, on the one value where the difference is hardest to notice.

`type` stays inert-when-`q`-is-absent on v2, so a UI can keep one query-string
builder for both its browse and its search. v1 has no version of the parameter to
be inert about, so it rejects it there too.

## What this costs

v1's blended count probe is live again, and it is the expensive one: a bounded
union across both branches on every uncached search. Its split-UNION form is what
makes it affordable at all — the OR'd form it replaced took 9.5s and 1.42GB of
disk reads for a single probe on the production catalogue. v1 also pays for two
row queries and an in-memory merge per search, where v2 pays for one.

This is the price of not changing an endpoint underneath its clients, and it is
charged only to callers who have not moved yet.

## Implementation

Both versions are one service and one controller body, not a fork. The only
branch is `ListBooksOptions.searchType`:

- **absent** — blended. `fetchBlendedSearchPage`, the union count probe, the
  title-leads-unless-fuzzy merge rule.
- **`'title'` / `'author'`** — one side. `fetchTitleSearchPage` or
  `fetchAuthorSearchPage`, each counting itself.

Absent is not the same as `'title'`, and the distinction is load-bearing rather
than incidental: `JSON.stringify` omits an absent key, so v1 and v2 hash to
different cache entries for the same query without anything having to arrange it.
The v1 controller never sets the field; the v2 controller always defaults it. That
is also why the cache prefixes are **not** bumped this time — the two versions are
already separated by the hash, and a bump would only cost a cold start on a
1.9M-row catalogue whose uncached searches are the expensive case the cache exists
for. The rows key stays `v6`, counts stay `v5`.

Everything else — filters, pagination, dedupe cursors, price bounds, the response
shape — is shared by construction, so a change to any of it lands on both versions
together.

## Explicitly out of scope

`GET /books/search`, the typeahead, is untouched on both versions. It still
accepts `type=all|title|author` and still defaults to blending. A dropdown of
eight suggestions is a different problem from a paginated result page: no
pagination to keep stable, no `total` to caption, and a user three characters in
genuinely has not said what they are looking for yet.

## Verified

`npx tsc --noEmit` clean. Full suite at 451 passing (3 pre-existing
`subscription-pricing` failures, unrelated — they need Stripe env config, and fail
identically on the parent commit).

`src/__tests__/search-type.test.ts` now covers both halves of the contract: v2's
default, both explicit values and its 400s, and v1 rejecting `type` on every value
including `title`, naming v2 in the error, rejecting it on a filter-only browse,
and — the positive half — never setting `searchType`, which is what selects the
blended path. It also pins the routing: the v2 router exposes exactly one route,
and it points at the handler that takes `type` rather than the frozen one. Every
other test in that file calls the handlers directly, so a crossed wire there would
otherwise have been invisible.

`src/__tests__/search-count-probes.test.ts` gains a block for v1's blended probe:
that it runs, that it reports the union total, that it keeps its UNION shape rather
than the OR that caused the 9.5s regression, that it is skipped when the count is
cached but rows are not, that it degrades to a title-only lower bound on timeout
without caching it, and that no v2 search of either side issues it.

`src/__tests__/blended-search-merge.test.ts` is new and covers the merge itself,
which nothing tested before — it was simply what the one search path did, and is
now one branch of three. Titles lead on the exact tiers; names lead once the title
branch has gone fuzzy; a book matching both sides appears once at its leading
branch's position; the fuzzy title pool is skipped while the exact band still has
rows; the cheap tier is held while name matches remain as supply (the "roald dahl"
page-3-reprints-page-1 case); and the same staging through v2 returns the title
matches alone.
