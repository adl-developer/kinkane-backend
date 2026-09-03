# Stop heavy baskets failing checkout with a server error

**Date:** 2026-09-03

## What changed

A basket heavy enough to need tracked postage could fail checkout with a bare
"Internal Server Error", even though the buyer had just been shown a valid
delivery price. It happened whenever the checkout request did not name a
shipping service (the common case — many clients never show a delivery chooser).

The cause was a mismatch between the two places a service is picked:

- The delivery **chooser** (`POST /cart/shipping-options`) prices every service
  and quietly drops the ones the parcel is too heavy for. Overseas untracked
  airmail stops at 2kg; tracked runs to 30kg. So for a ~2.5kg basket it offered
  only tracked, which is what the buyer saw.
- **Checkout**, when no service was named, fell back to
  `defaultServiceCode()`, which chose the cheapest service that merely *served
  the country* — untracked — **without checking the parcel fitted it**. Pricing
  then found no weight band for a 2.5kg parcel on the untracked service and
  threw, and the buyer got a 500.

A single 1,852g title (a hardback aviation book) was enough to tip a normal
three-book order over the untracked ceiling, which is why "it works for other
books".

## The fix

`defaultServiceCode()` now takes the parcel and applies the **same weight
filter the chooser uses**: it prices each candidate service, keeps only the ones
that can actually carry the parcel, and returns the cheapest of those. The
default and the offered options can no longer disagree about what fits, so an
omitted service code resolves to tracked (which fits) instead of failing.

Checkout measures the parcel *before* choosing a service (it has to, now that
the choice depends on weight) and passes it in.

If genuinely nothing can carry the parcel (heavier than even the 30kg tracked
ceiling — dozens of hardbacks), checkout now returns a clear
`409 PARCEL_TOO_HEAVY` ("remove an item and try again") instead of the previous
misleading `COUNTRY_NOT_SUPPORTED`, which is reserved for destinations with no
published rate at all.

## Not in scope

When a client *explicitly* names an unfittable service, checkout still lets
pricing refuse it — but that refusal is now a readable error rather than a 500
(see the companion change that stops masking tagged service errors).

## Verified

`src/__tests__/shipping-options.test.ts` gains cases proving the default steps
up from untracked to tracked once a parcel passes 2kg, stays on untracked below
it, and returns null when nothing can carry the parcel at all. Full type-check
and the shipping-options suite pass.
