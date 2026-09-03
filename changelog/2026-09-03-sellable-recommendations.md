# Recommendations only ever suggest books the shop can sell

**Date:** 2026-09-03

## What changed

No recommendation surface can return a book the shop cannot sell any more. That
covers all seven of them:

| Surface | Endpoint |
|---|---|
| Basket carousel | `GET /books/recommendations?bookIds=` |
| "You may also like" | `GET /books/:id/similar` |
| Trending | `GET /explore/trending` |
| Personalised feed | `GET /explore/personalized` |
| Bestsellers (and its trending fallback) | `GET /explore/bestsellers` |
| Onboarding quiz results | `POST /recommendations`, `POST /recommendations/refresh` |
| Recommendation email / push | the nightly job and the post-refresh send |

"Cannot sell" is the definition already used at the checkout gate, unchanged: no
ISBN13, no live supplier price, or a Gardners report code saying the title
cannot be supplied. Out-of-stock books are *not* excluded — extended-catalogue
and print-on-demand titles have no shelf but are genuinely orderable, and stock
moves hourly, so filtering on it would make books flicker in and out of a feed.
Withdrawn (`is_removed`) titles are excluded too.

Second change, from the same review: **the `shoppable` parameter is gone from
these endpoints entirely.** Not defaulted to on — removed. There is nothing for
a client to send.

## Why

The filter existed but was opt-in. `shoppable=true` turned it on, and it
defaulted to off, so a client that did not pass the flag got recommendations it
could not sell — every card on these surfaces carries an Add button, and that
button 409s at the cart. Worse, two paths never applied the filter at all
whether or not the flag was passed:

- **the personalised feed**, which built its own `WHERE` and skipped the shared
  predicate entirely — so the one feed actually branded as recommendations could
  surface both unsellable *and* withdrawn books; and
- **the onboarding quiz**, whose results are the first books a new reader ever
  sees.

Neither of those is a flag anyone could have set correctly. Being sellable is a
property of *being worth recommending*, not of the caller having asked to shop,
so it is no longer a parameter.

## API shape

No response field changed shape. One request parameter was removed.

- **Before:** `shoppable=true` filtered out unsellable books *and* attached
  `unitPriceMinor`, `compareAtMinor`, `currency`, `inStock`. Default `false`, so
  the useful behaviour was the one you had to know to ask for.
- **After:** no parameter. Recommendations are always sellable and always
  priced.

A stray `?shoppable=` is **ignored rather than rejected**. An old client sending
`shoppable=true` was asking for exactly what it now gets unconditionally, so
failing its request would be pedantry; one sending `shoppable=false` was asking
for something these endpoints no longer offer, and quietly giving it the priced
list is better than a 400 it has no way to handle. (Contrast `type` on
`GET /api/v1/books`, which *is* rejected — there the parameter means something
the endpoint genuinely cannot do, so silence would look like a ranking bug.)

The practical effect for an existing client that never passed the flag: fewer
books come back (the unsellable ones are gone) and each one now carries a price.
A client that passed `shoppable=true` sees no change at all.

**`GET /books` keeps its `shoppable` flag, deliberately.** It means something
different there — it *ranks* the page into three bands rather than filtering it,
because a catalogue that changes size with a query parameter cannot be paged
through consistently. It keeps both its parameter and its `false` default, and
there is a test pinning that so the two meanings do not get "harmonised" by
mistake.

## Non-obvious decisions

**Both `buildFeedCondition()` and `attachShopFields()` lost their parameter
rather than gaining a default.** The signature is the enforcement: while it read
`buildFeedCondition(shoppable)`, every one of its call sites was an opportunity
to pass nothing and silently get the unfiltered catalogue — which is precisely
what the bestseller chart and the default-off feeds were doing. With no
parameter there is no way to opt out, and a test asserts the arity. The same
went for the flag threaded down through `trending`, `personalized`, `similar`,
`basketRecommendations` and the bestseller chart: a parameter still present on
the service is one a future controller can start passing again, which is how the
flag came to mean two different things in the first place.

**`shopCurrency(req)` no longer returns undefined.** It used to, for a caller
that had not asked to shop — that was what "a feed with no prices" looked like.
There is no such feed now.

**The quiz and the email import that same function rather than restating the
predicate.** A second copy of the unsuppliable report codes is exactly the drift
`lib/shoppable.ts` exists to prevent: a code added to one list and not the other
leaves a title recommended and unbuyable, with nothing to notice it by.

**Feed cache keys were bumped, and `shoppable` dropped out of them.** Two
reasons. The pre-existing `:all` pools were written by the unfiltered code and
would have kept serving unsellable books for up to an hour after deploy. And now
that the filter no longer depends on the flag, the `shop` and `all` pools are
the same list — keying on it would just cache everything twice.

- `trending:v4:*` → `trending:v5:<limit>`
- `personalized:v2:*` → `personalized:v3:<userId>:<limit>`
- `similar:v3:*` → `similar:v4:<bookId>:<limit>`
- `bestsellers:v3:*` → `bestsellers:v4:<window>:<limit>`

Old keys are simply abandoned, not deleted — they expire on their own TTL.

Renaming the personalised key surfaced a separate, pre-existing bug worth
fixing in the same breath: the helper that clears a user's personalised feed
after they reject a book was deleting `personalized:v1:`, and had been since the
key moved to `v2`. It matched nothing, so a rejected book stayed in that
reader's feed for the full hour. The prefix is now a named constant with a test
asserting it equals what the feed actually writes.

**Pools are now always over-fetched.** `feedPoolMultiplier` used to widen the
candidate pool only when `shoppable` was set, because roughly a fifth of the
catalogue is unsellable and these feeds fetch a bounded pool then trim. Since
the trim now always happens, the widening always applies — otherwise a "top 10"
comes back holding three.

## Out of scope

- **Rights/market restrictions.** They depend on a destination country these
  endpoints do not have, and the check fails *closed* — with
  `GARDNERS_REGION_BY_COUNTRY` unpopulated it treats every restricted title as
  blocked, which would silently shrink every feed. Still enforced at
  add-to-cart, where a real destination exists.
- **Stock.** Deliberately not a filter, for the reasons above.
- **`GET /books`**, as described.

So this is necessary but still not sufficient for a sale: everything now
excluded is certainly unbuyable, but what survives still clears the full gate at
add-to-cart.

## How it was verified

`npx tsc --noEmit` clean, and `npx vitest run` — 659 passing.

New `src/__tests__/recommendation-sellability.test.ts` (13 tests) pins the
invariant per query site rather than on the shared helper, because nothing in
the type system stops an eighth recommendation query from being written without
it. It checks the compiled SQL excludes withdrawn titles, requires an ISBN13 and
a live supplier price, and carries the shared code list; that each of the seven
paths applies it; that `shoppable` appears in none of the recommendation
schemas or feed-service signatures, and still appears with its `false` default
on the catalogue listing.

Three existing tests changed meaning and were updated rather than deleted, each
keeping a comment recording that the old behaviour was correct at the time: the
bestsellers cache test asserted the shoppable and unfiltered charts occupied
*separate* keys and now asserts one key serves both; the fallback test asserted
the flag was carried into trending; and `feed-prices` asserted the shop fields
were omitted when the caller had not asked to shop.

Four failures in `referral-copy` and `subscription-pricing` are pre-existing and
unrelated — confirmed by running both files against a stashed tree.
