# "Readers like you loved" — a books rail for your reader type

**Date:** 2026-09-15

## What changed

A new endpoint behind the "Readers like you loved" rail: a paginated list of
books that other readers sharing your reader type have responded well to.

```
GET /api/v1/explore/reader-type?limit=20&offset=0&readerType=The%20Seeker
Authorization: Bearer <token>
```

`readerType` is optional and overrides which cohort is read; omit it and the
caller's own is used. Send the exact enum value, URL-encoded. An unrecognised
value is a `400` rather than an empty list — the two would otherwise be
indistinguishable to a client, and a typo would read as "nobody shares your
type". It is validated against the database enum before it reaches the query.

It also makes the endpoint usable by a reader who has no reader type yet, and
testable before there are real cohorts to hit.

```json
{
  "books": [ { "id": 48213, "title": "…", "coverUrl": "…", "contributors": [], "genres": [] } ],
  "pagination": { "total": 137, "limit": 20, "offset": 0, "hasMore": true }
}
```

Requires sign-in. **Not** Plus-gated: the likes feeding it are a Plus feature,
but seeing what a cohort reads is discovery — and this is exactly the rail that
shows a free reader what members are reading.

**It returns `200` with an empty array in two cases**: the caller has no reader
type, and nobody else shares theirs. Neither is an error. Both mean the same
thing to the client — there is no rail to draw — and a `404` for one of them
would only give the app a second code path to the same rendering.

## What counts as a book the cohort loved

Three signals, not just the explicit like:

| signal | column |
|---|---|
| liked it | `user_books.liked = true` |
| finished it | `user_books.status = 'read'` |
| named it in the quiz | `user_books.source` in `chosen_from_onboarding`, `chosen_from_quiz` |

The explicit like alone was not enough to build a rail on. Liking is a Plus
feature (see the note at the top of `db/schema/saved-books.ts`), so on a mostly
free user base a cohort's like pool is thin enough that smaller reader types
would return almost nothing.

A person counts **once** per book however many of the three they trip — a book
someone liked *and* finished *and* picked in the quiz is one supporter, not
three. The caller's own shelf never counts toward a book's score: "readers like
you" means other readers, and without that a book only they had liked would
appear in a rail claiming the cohort loved it.

`saved_books` is deliberately not a signal. It is the shop's purchase wishlist —
intent to buy, not a response to having read something.

## Non-obvious decisions

**Support is counted per work, not per catalogue row.** This is the one that
actually bit during verification. Counting likes per `book_id` and collapsing
editions afterwards looks equivalent and is not: a title the cohort loves across
a paperback, a hardback and an ebook splits its support three ways, and whichever
edition survives the collapse then ranks *below* a book one single reader liked.
Before the fix, a work two cohort members had liked across two editions came back
**last**, behind three single-liker books. The query now scores works first
(`work_scores`), then picks the edition the cohort actually picked up to
represent it.

**The cohort is read regardless of `shelf_visibility`, because the response is an
anonymous aggregate.** It returns books and nothing else — no liker names, no
avatars, and not even the count that drives the ranking. That is the whole basis
on which reading a private shelf is acceptable here. **If a future change
attaches names, avatars or counts to these rows, the query has to start filtering
on `shelf_visibility` first**: a private shelf is reconstructable from a liker
count of one. There is a test asserting nothing identifying reaches the response,
so this fails loudly rather than quietly.

**Cohorts are keyed on `users.reader_type`, which retakes do not move.** That
column is written at signup; a logged-in quiz retake records its newly inferred
type in `preference_history` and deliberately leaves the user row alone (see
`lib/reader-type.ts`). So a reader who has retaken the quiz is still cohorted by
their original type. This is a known limitation rather than an oversight — and it
keeps the rail consistent with the profile label the app prints above it, which
comes off the same column. Following retakes means a per-user latest-row lookup
over preference history on both sides of the query.

**Uncached, unlike every other feed in `books.service.ts`.** Those cache a
fixed-size pool for an hour. This one is offset-paginated, so a cache key would
have to carry the offset and each page would expire independently — which is how
a reader pages from a fresh page 1 into an hour-stale page 2 and sees the same
book twice.

**Ordering carries an explicit `id` tiebreak.** Equal liker counts are the normal
case in a small cohort, and without a deterministic tiebreak Postgres may order
them differently per query — offset pagination over an unstable sort silently
repeats and drops rows. The kind of bug that only appears on page two.

**The work key is copied verbatim from `lib/exclusions.ts`**, down to using
`lower(btrim(...))`. This database's ctype is `C`, so `lower()` folds accented
titles by byte rather than by locale — a real limitation, but the exclusion
filter already behaves that way, and two different spellings of "the same book"
in one codebase is how a filter quietly stops matching. Improving it means
changing both together.

**`total` comes from a `COUNT(*) OVER ()` window on the final set**, not a
separate count query: a second query can count rows the caller could never page
to, and can disagree with the page about a like that landed between them.

## Excluded from the results

- Books already on the caller's shelf, and books they have swiped away — both
  via the existing `getUserExclusions`, matched at work level, so a paperback on
  the shelf suppresses the hardback too.
- Books the shop cannot sell or that have been withdrawn (`buildFeedCondition`),
  and rows with no named author (`buildHasAuthorCondition`) — the same predicates
  every other feed uses.

## Out of scope

**No price or stock on these rows.** Every other discovery feed is a shop surface
and attaches live prices per request; this is a carousel with no Add button, so
there are no `unitPriceMinor` / `inStock` fields and no `currency` parameter.
Unsellable titles are still filtered out, so the rail never advertises something
unbuyable. If it gains an Add button, that is a call to `attachShopFields` at the
return — on every request, never inside a cache.

Also out of scope: exposing the liker count, following quiz retakes between
cohorts, and any per-viewer caching.

## A note on the reader-type override

`readerType` lets any signed-in reader read any of the eight cohorts, not just
their own. That is a deliberate widening and it is worth being explicit about
what it does and does not open up.

It changes *which* cohort is read, never *what* may be read about one: the
response stays books-only, the caller is still excluded from the count, and their
own shelf and dislike exclusions still apply. So nothing is visible through the
override that the same endpoint would not show a member of that cohort.

What it does change is that all eight cohorts are now enumerable by one account
rather than one. The residual risk is unchanged in kind but wider in reach: in a
cohort with exactly one other member, the rail *is* that member's shelf, and
someone who knows who is in a given cohort could attribute it. That was already
true of your own cohort before this param existed. It stays acceptable only while
the response carries no identities and no counts — which is the same condition
the endpoint already rests on, and which is asserted in the tests.

## How it was verified

The invariants that break *silently* are asserted in
`src/__tests__/reader-type-feed.test.ts` (15 tests, source/SQL assertions in the
style of `feed-prices.test.ts`) — privacy, single-count-per-supporter, work-level
scoring, the null-safe author join, the pagination tiebreak, and the absence of
caching.

The override was exercised separately against a seeded three-user fixture: a
caller with no reader type reading a cohort by name, the override actually
switching cohorts rather than merely being accepted, an explicit own-type request
matching the implicit one exactly, the caller still being excluded from a cohort
they were named into, an unpopulated cohort returning empty, and the schema
rejecting both an off-by-one typo and a SQL-ish string while accepting all eight
enum values.

The behaviour was then exercised against the local database with a seeded
five-user cohort over real catalogue rows: ranking by liker count, each of the
three signals counting on its own, a supporter tripping all three counting once,
the caller's own likes and shelf books being excluded, two editions of one work
collapsing into a single correctly-scored row, non-overlapping pages, and both
empty-result cases. All passed after the work-level scoring fix. The seed script
was temporary and is not checked in.

Two pre-existing test failures in `subscription-pricing` and `referral-copy` are
unrelated and were confirmed to fail without this change.
