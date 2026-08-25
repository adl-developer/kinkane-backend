# Books a reader rejects stay rejected

## What changed

Two related gaps, both versions of "we recommended you a book you already told
us about".

**The book you just said you'd read.** The onboarding quiz asks which books
you've enjoyed, and those were excluded from your recommendations by book ID
alone. The catalogue holds many rows for the same work — hardback, paperback,
reissue, each its own ID — so a different edition of a book you named came
straight back as a recommendation. Exclusion now matches on title **and**
author, so every edition of a named book is filtered out.

**The book you swiped away.** Rejections weren't recorded anywhere. A new
table, `user_disliked_books`, stores every book a reader swipes away on the
recommendation list, accumulated across onboarding and every subsequent quiz.
Those books — and other editions of them — are now filtered out of every
surface that suggests a book to a reader: every quiz retake, the personalized
home feed, trending, "you may also like" on book detail, and recommendation
emails. (The first quiz needs no filtering — the reader hasn't rejected
anything yet.)

Search, browse and book detail are deliberately *not* filtered: if a reader
goes looking for a book by name, hiding it would be a bug, not a feature.
Rejection suppresses recommendations, not the catalogue.

Nothing is captured until the mobile app sends the IDs; the backend is additive
and inert until then. See `docs/mobile-integration.md` for the client
checklist.

## Data shape

`user_disliked_books`, one row per user per book, never deleted:

| Column | Notes |
| --- | --- |
| `user_id`, `book_id` | unique together — the upsert target |
| `title_normalized`, `author_normalized` | snapshot taken at the moment of the dislike |
| `source` | `onboarding_selection` \| `quiz_refresh` \| `app` |
| `dislike_count`, `first_disliked_at`, `last_disliked_at` | a repeat rejection bumps the count rather than adding a row |

API changes, both additive and both optional:

- `POST /guest-sessions/:id/selections` accepts `dislikedBookIds` alongside
  `chosenBookIds`. Parked on the guest session, promoted into
  `user_disliked_books` at registration.
- `PATCH /recommendations/refresh` accepts `dislikedBookIds`.
- `GET /recommendations/preferences` returns `dislikedBookIds`.

## Decisions worth knowing about

**Dislikes accumulate; they are never replaced.** Every other field on
`/refresh` is a full replacement — send the whole list or lose what's missing.
This one is a delta: the IDs sent are added to what's already there, and
omitting the field clears nothing. A reader who retakes the quiz five times
should end up with the union of everything they've ever rejected, not just the
last batch.

**Title and author are snapshotted at dislike time.** The point of the
exclusion is to catch *other editions* of a rejected work, which means matching
on something other than the book ID. Storing the normalized title/author at the
moment of rejection means the match keeps working even if the book's
contributor rows change under a later ONIX ingest.

**Not-chosen is not the same as disliked.** A reader is shown up to 100
recommendations and picks 5. Only books the client explicitly flags as swiped
away are recorded. Treating the other 95 as rejections would poison the set
within a single quiz.

**A rejection with no known author falls back to title-only matching.** If the
catalogue has no author for a book the reader rejected, there's nothing to
anchor a stricter match on. Not re-recommending a same-titled book is the
better error than recommending the thing they just swiped away.

**One rule, two encodings.** The exclusion exists as a SQL predicate (for
anything that runs a query) and as an in-memory filter (for "you may also
like", explained below), both in `lib/exclusions.ts`. They have to agree — a
book excluded from one surface but not another is exactly the bug this is
meant to prevent — so they sit next to each other and are tested together.

**The shared feeds keep their shared caches.** "You may also like" is cached
per *book* and trending is cached globally, and both are served to every user —
which is what makes them cheap. Keying either per user would multiply cache
cardinality by the size of the user base. Instead each cache now holds 10 rows
more than requested, and each viewer's rejections are filtered out of that pool
after the cache read. The trade: a reader who has rejected an unusual number of
books in one of these pools can get a slightly short list. That's acceptable
for a secondary shelf and strictly better than showing them books they
rejected.

**Trending is filtered per viewer, but still ranked globally.** The ranking
itself is untouched — a rejected book still counts toward what's trending for
everyone else, because one reader's taste shouldn't move a popularity
leaderboard. It simply isn't shown to the reader who rejected it. `/trending`
is now an `optionalAuth` route for this reason: anonymous callers get the list
unchanged, signed-in ones get their rejections removed.

**The guest quiz endpoint stays unauthenticated.** `POST /recommendations` runs
before an account exists, so there is no rejection history to apply — a guest
hasn't been shown a list to swipe on yet. Their swipes are saved to the guest
session and start filtering once registration turns them into a user. A
signed-in reader retaking the quiz goes through `PATCH /refresh`, which loads
their exclusions.

**Rejections are part of the recommendation cache key.** Otherwise two users
with identical quiz answers but different rejection histories share a cached
result set, and one of them gets back the books they swiped away. Cost: fewer
cache hits for logged-in users, whose rejection sets are personal to them. The
guest flow is unaffected — a fresh guest has no history.

**A failed exclusion lookup degrades to "no exclusions" rather than throwing.**
The cost of that degradation is one unwanted book in a list. The cost of
throwing is an empty screen.

## Cache invalidation

Recording a dislike busts both the user's cached exclusion set and their
personalized feed, so a swiped-away book disappears immediately rather than at
the next TTL expiry.

Adding rejections to the recommendation cache key also changes the key for
*every* existing entry, so all cached recommendations are effectively
invalidated on deploy. That's intended — the old entries were computed under
the old edition-matching rule and would keep serving duplicates for up to 48
hours otherwise.

## Out of scope

- No un-dislike / undo endpoint. Rejections are currently permanent.
- No `dislike` interaction type. `user_interactions` feeds the trending score;
  introducing a negative signal there is a separate design question.
- Search, browse, author pages and book detail — reachable on purpose, so not
  filtered.
- No standalone "not for me" endpoint for rejections made outside a quiz. The
  service method already reserves an `app` source for it if that UI appears.

## How it was verified

Typecheck (`tsc --noEmit`) and the full test suite (60 tests) pass. Eleven new
unit tests in `src/__tests__/exclusions.test.ts` cover the exclusion rule in
both encodings: normalization, the null-author fallback, a same-titled book by
a different author being *kept*, a different edition being dropped, and
non-primary contributors (translators, editors) not counting as author
matches.

Not verified against a live database: the query-plan cost of the title/author
predicate inside the pgvector searches on the full catalogue. Worth an
`EXPLAIN ANALYZE` on a real dataset before this carries production traffic —
see below.

## Known risk

These vector queries run under a raised `hnsw.ef_search` and apply filters
after the index scan, so each added predicate makes it likelier a candidate
pool comes back short. Exclusion sets of a few dozen books should be fine; a
reader with hundreds of rejections may need `FEED_POOL_MULTIPLIER` raised. The
work-level predicate is written as a single `NOT EXISTS` over a `VALUES` list
specifically so the query shape doesn't degrade as a rejection list grows.
