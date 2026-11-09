# New Kinkané Plus prices

**Date:** 2026-11-09

## What changed

| | Standard | Founding Member (until 2027-01-14) |
|---|---|---|
| Monthly | $6.99 (was $8.99) | $5.99 (was $6.99) |
| Annual | $59.99 (was $79.99) | $49.99 (was $59.99) |

The new prices are in Stripe. This change updates the docs, the API example and the Founding Member line in the subscription confirmed email. No billing code changed: `GET /user/subscription/plans` already reads amounts from Stripe.

## Founding Member wording

`.env.example`, the plan docs and the email still said founding pricing lasted for the "first term" only. The code stopped working that way on 2026-08-13 (see `2026-08-13-founding-lifetime-pricing.md`). Founding members renew at the founding price until the offer has closed and their current billing period has ended, then move to the standard price. The wording now matches the code.

## Decisions

- **"3 months" means the launch window**, set by `FOUNDING_OFFER_ENDS_AT`. It is not each user's free 90-day in-app trial, which is unchanged.
- **The offer ends on 2027-01-14.** The earlier env value of 2026-01-14 was already in the past, which turned founding prices off.

## Left out of scope

- App Store Connect prices, which have to be changed separately.
- Older changelog files, which keep the prices that applied when they were written.

## How it was verified

The four live Stripe price IDs in `.env.prod` were read back from the Stripe API and match the table above. The live account has no subscriptions, so nobody needs moving to a new price. The deployed server's settings were not checked, and no checkout was run against the new prices.
