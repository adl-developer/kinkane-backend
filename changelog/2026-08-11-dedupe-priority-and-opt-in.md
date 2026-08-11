# Pick the best edition when deduping, and make it opt-in on the catalog endpoints

**Date:** 2026-08-11

## What changed

Two changes to how same-titled book editions get collapsed into one:

**1. Smarter pick, not just "first one wins."** `dedupeByTitle` and
`dedupeByTitleAndSubtitle` (`src/lib/dedupe.ts`) previously kept whichever
edition happened to rank first in the underlying query and dropped the rest.
They now score every candidate and keep the best one, in priority order:

1. Has a cover image
2. Has a complete dataset — a short description, at least one genre, and is
   available to order (ONIX availability code `20`/`21`/`22`/`23`)
3. Most recent publication date
4. Has a price

A tie at every criterion falls back to whichever edition was already kept
(i.e. the original rank/relevance order), so this is a strict improvement on
the old rule rather than a different one. This affects all five existing
callers: `recommendationsService`'s candidate selection, and
`booksService.trending()` / `.personalized()` / `.similar()` /
`.suggestions()`.

**2. `GET /books` and `GET /books/search` gain an opt-in `dedupe` param.**
`.suggestions()` (the `/books/search` typeahead) used to always dedupe by
title+subtitle; `.list()` (`GET /books`) never deduped at all. Both now take
a `dedupe` query param (`true`/`false`, default `false`), so:

- The web app calls these without `dedupe` and keeps seeing every edition of
  a title, so people can pick the specific hardback/paperback/reissue they
  want to buy.
- The mobile app passes `?dedupe=true` and gets one row per title.

`GET /books/:id`, `.getById()`, is untouched — a single book lookup has
nothing to dedupe against.

## Data/API shape

- New query param on `GET /api/v1/books` and `GET /api/v1/books/search`:
  `dedupe=true|false` (default `false`).
- When `dedupe=true` on `GET /books`, `totalIsApproximate` is now always
  `true`. `total` still counts raw rows, not distinct titles — computing an
  exact distinct-title count would mean an unbounded `GROUP BY` over the
  same 1M+-row table `SEARCH_COUNT_CAP` already exists to avoid scanning for
  search — so `total` becomes a lower bound and `hasMore` is the thing to
  paginate on, same contract search already uses.
- No schema/migration changes — service-layer logic only.

## Non-obvious decisions

- **Scoring fields are fetched but never returned.** None of `suggestions()`,
  `trending()`, `personalized()`, or `similar()` return `shortDescription`,
  `availabilityCode`, or price/genre counts in their public response shapes.
  Rather than changing those shapes, each of these functions now fetches a
  bit more from `books` (all plain columns, no extra join, since
  `shortDescription`/`availabilityCode`/`publicationDate` all live directly
  on the row) plus one batched `bookPrices` existence query, builds an
  internal "scoring row," runs the dedupe, and strips the scoring-only
  fields back off before caching/returning. See `FeedScoringRow` /
  `stripFeedScoring` in `books.service.ts`.
- **`/books/search`'s id-level de-dup still always runs.** Independent of
  the new `dedupe` flag: if the same book id matches on both the title side
  and the author side of a typeahead query, it still only appears once.
  That's not "two editions of a work," it's literally the same row — the
  flag only controls whether *different* rows sharing a title get grouped.
- **`GET /books` over-fetches a fixed headroom (`DEDUPE_POOL_HEADROOM = 20`)
  per page when `dedupe=true`, not a multiple of `limit`.** The feed
  functions (trending/personalized/similar) already over-fetch
  `min(limit × 3, 100)` because they're capped, cached candidate pools. Plain
  catalog browsing is different: it's a real `LIMIT/OFFSET` scan over a
  1M+-row table with no cap, and deep pages are supposed to stay cheap. A
  fixed headroom keeps that scan's cost independent of how deep the page is,
  at the cost of not *guaranteeing* a full page back when duplicate editions
  happen to cluster at a given offset — the same trade-off
  `FEED_EXCLUSION_HEADROOM` already makes elsewhere in this file.
  `hasMore` is computed correctly either way, so a caller just sees a
  shorter-than-usual page rather than wrong pagination.
- **Availability codes for "available to order" (`20`/`21`/`22`/`23`) are a
  product decision, not derived from anything else in the codebase** — there
  was no existing convention for which ONIX List 65 codes count as
  orderable (the field was previously just an opaque pass-through). Centralized
  in `lib/dedupe.ts` (`AVAILABLE_TO_ORDER_CODES`) rather than duplicated
  across call sites, so it only needs updating in one place if the
  catalogue's codes turn out to need adjusting.
- **Backfill candidates in `recommendationsService.fetchCandidateBooks()`
  keep the old first-seen-title rule**, not the new priority scoring. That
  pass only runs when the primary similarity pass came up short of
  `TARGET_RESULTS`, pulling from a strictly worse-match pool to top the list
  off — scoring rows against each other there isn't worth the extra
  queries for what's already a fallback path.
- **Cache keys were bumped where the cached payload's meaning changed**:
  `suggestions()` moved from `v2` to `v3` (results now depend on `dedupe`,
  and old `v2` entries were always deduped, so they'd be wrongly served as
  the new non-deduped default), and `list()`'s row cache moved from `v3` to
  `v4` for the same reason. `list()`'s count cache key is untouched since its
  cached value (raw row count) means the same thing regardless of `dedupe`.

## Out of scope

- No fuzzy/near-duplicate title matching — still an exact normalized
  (trim + lowercase) match, same as before.
- No UI/client changes — this is the API side only.
- Didn't add `dedupe` to the four always-on endpoints (recommendations,
  trending, personalized, similar) — deduping there isn't optional, only
  *how* the winner is picked changed.

## How it was verified

`npx tsc --noEmit` (clean) and `npx vitest run` (243 tests, 240 passing —
the 3 failures are in `subscription-pricing.test.ts`, a pre-existing,
unrelated Stripe founding-member pricing/date issue confirmed present on
`main` before this branch). Rewrote `dedupe.test.ts` with 17 cases covering
each priority tier individually, tie-breaking, and the case-insensitive key
matching from the original tests.
