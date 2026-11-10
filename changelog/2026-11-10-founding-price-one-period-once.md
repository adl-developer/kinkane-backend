# Founding price: one billing period, once per account

## What changed

The founding price used to renew until the account's 3-month founding window
closed. It now covers **one billing period**, the first month or the first
year, and each account can use it **once**:

- **Once per account, on web and App Store together.** After a founding
  period has been paid, the account gets standard prices even if it cancels
  and comes back inside the window. In that case `GET /plans` and
  `GET /subscription` report `foundingOfferActive: false` and
  `foundingOfferEndsAt: null`, checkout charges standard, and `apple/offer`
  returns `offer: null`.
- **The second period is standard.** The founding-to-standard Stripe schedule
  is now attached after the first founding invoice, so the next renewal is
  standard, whether or not the window is still open.
- **Plan switches always go to standard.** A switch takes effect at a renewal,
  which is after the one founding period.
- **Existing founding members** (including the old launch-window "legacy"
  ones) keep founding until their next renewal, then pay standard. The daily
  Stripe reconciliation job attaches the schedule for anyone who doesn't have
  it yet, so no backfill script is needed.
- **App Store:** monthly buyers now get the 1-month founding offer
  (`founding_monthly_1m`) instead of up to 3 months. Annual is unchanged
  (first year).
- **Welcome email** now says the founding price is "for your first month" (or
  "first year"), not "until your first 3 months are up".

## Why

Client decision on 2026-11-10: the discount is a single introductory period,
and using it once uses it up.

## Decisions

- **"Used" means a paid founding period**, read from
  `subscription_state_history` (any row with `is_founding_member` and tier
  `plus`). A failed or abandoned checkout doesn't use it, and no new column or
  backfill is needed. Existing founding members already have such rows.
- **Reactivating never brings it back.** Reactivate and plan-change paths
  re-attach the rollover too.
- The founding window itself still exists: the offer is only made in the
  first 3 months after sign-up.

## Out of scope / to do outside the code

- **App Store Connect:** take the 2m and 3m monthly founding offers off sale.
  Apple subscribers already on a multi-month offer keep it, because Apple
  fixes the duration when the offer is redeemed.
- Anyone whose next renewal is in the next few hours, before the reconciliation
  job runs, may get one more founding renewal.

## Verification

- Unit tests: the rollover is attached at the next renewal, inside the window
  and for legacy subscriptions; reactivation re-attaches it; plan switches
  target standard; the Apple offer is always 1 month.
- Integration tests on a scratch Postgres
  (`renewal-founding.integration.test.ts`): `foundingEndsAt` for a new
  account, an account that has used founding, a trial-only account, and a
  closed window.
- Typecheck and the full unit suite pass. Not run against Stripe or Apple
  sandboxes.
