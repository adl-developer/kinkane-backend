# Founding price for each account's first three months

## What changed

The Founding Member price used to run on one launch-wide date
(`FOUNDING_OFFER_ENDS_AT`): everyone who subscribed before it got the founding
price until then. Now every account gets its own window: **the first three
months after it signs up** (`FOUNDING_PERIOD_MONTHS`, default 3).

- **Monthly:** founding price on every renewal that starts inside the window.
  The first renewal on or after the window's end bills the standard price.
- **Annual:** buying annual inside the window gets the founding annual price
  for the whole first year, then standard.
- **After the window:** checkout and the plans list show standard prices only.
- **`isFoundingMember`** now means "paying a founding price right now". It turns
  off on the first standard-priced renewal (before, it stayed on for good).

## Web (Stripe)

- Checkout stamps the window's end on the subscription's metadata
  (`foundingEndsAt`).
- On every `invoice.paid` (the first invoice included), if the next renewal
  lands on or after that date, a schedule is attached that moves it to the
  standard price at that renewal. Reactivating and undoing a plan change
  re-run the same check.
- A plan change keeps the founding price only if it takes effect inside the
  window. Previously, a plan change onto a founding price left a schedule
  whose last founding phase never ended, which blocked the rollover. It is now
  released and replaced with the rollover.

## iPhone (App Store)

Apple can't end a price on a date we choose, so the founding price is sold as
**promotional offers** on the standard products:

| Offer identifier       | Product | Covers           |
| ---------------------- | ------- | ---------------- |
| `founding_monthly_1m`  | monthly | 1 month          |
| `founding_monthly_2m`  | monthly | 2 months         |
| `founding_monthly_3m`  | monthly | 3 months         |
| `founding_annual_1y`   | annual  | 1 year           |

New endpoint **`POST /api/v1/user/subscription/apple/offer`** `{ plan }` returns
`{ offer }`: the offer whose length reaches this user's window end, signed with
the existing In-App Purchase key. Once the window has closed it returns
`{ offer: null }`. The app passes the offer to StoreKit with the purchase.
Apple marks every period the offer covers, so the server sets
`isFoundingMember` from the transaction's offer.

## API shape

- `GET /user/subscription`: `foundingOfferActive` is now per user; adds
  `foundingOfferEndsAt`.
- `GET /user/subscription/plans`: `foundingOfferActive` / `foundingOfferEndsAt`
  are per user.
- The confirmation email says "until your first three months with Kinkané are
  up" (monthly) or "for your first year" (annual).

## Decisions

- **Window starts at sign-up**, not at first payment. Trial time counts against
  it, and someone who subscribes after three months gets no founding price. No
  new column was needed: it comes from `users.created_at`.
- **Existing founding subscribers keep their deal.** Their subscriptions carry
  no `foundingEndsAt`, so they fall back to `FOUNDING_OFFER_ENDS_AT`
  (2027-01-14 on prod), as before. "Early" App Store products bought inside
  that window still count as founding.
- Offer identifiers are fixed in code rather than configured, since they must
  match App Store Connect exactly.

## Out of scope / to do outside this repo

- **App Store Connect:** create the four promotional offers above, and remove
  the "Early" products from sale.
- **iOS app:** call `/apple/offer` before each purchase and pass the result
  to StoreKit. Stop showing the Early products. Show "your founding price
  ends on `foundingOfferEndsAt`".
- **To check in sandbox:** Apple has historically limited promotional offers to
  existing or lapsed subscribers. If a first-time buyer can't redeem one, fall
  back to a 3-month introductory offer, which means iPhone buyers could get
  slightly longer than web buyers.
- No backfill of `is_founding_member`: nobody has rolled onto standard yet,
  because the legacy window is still open.

## Review fixes

- **Legacy timing kept.** Subscriptions with no `foundingEndsAt` stay founding
  on every renewal billed before 2027-01-14, and roll on the first invoice after
  it, exactly as before. Without this, legacy monthly members would have lost a
  month and legacy annual members a year.
- **Metadata on every schedule phase.** Rollover and plan-change schedules copy
  the subscription's metadata onto each phase, so `foundingEndsAt` and `userId`
  survive a phase change.
- **Rollover retry.** The daily reconciliation cron re-runs the rollover check
  for every live founding subscription. invoice.paid swallows Stripe errors,
  and for annual the first invoice is otherwise the only chance for a year.
- **Apple:** `/apple/offer` refuses with 409 `STRIPE_SUBSCRIPTION_ACTIVE` for
  web subscribers, so they can't be billed twice. It has its own 60/hour limit,
  so offers can't use up `/apple/verify`'s budget. A new purchase of an "Early"
  product is logged as an error, because only App Store Connect can stop it.
- Email and docs follow `FOUNDING_PERIOD_MONTHS` instead of saying 3. Subscription
  reads look up the founding window in parallel.

## Verification

- Unit tests: per-account window (month-end clamping, offer off), metadata vs
  legacy end date, `resolvePrice` against the window, Apple offer choice at
  each length, offer detection, and the signature verified against a
  generated P-256 key.
- Updated Apple sync tests (flag drops after the offer) and reactivate tests
  (rollover waits until the next renewal is past the window).
- New `founding-rollover` tests: rollover due/not due, the legacy timing, a
  pending change left alone, a finished plan-change schedule replaced,
  metadata on every phase, and plan-change target prices.
- Full suite: 1660 tests pass; `tsc` clean. Not run against live Stripe or the
  App Store sandbox.
