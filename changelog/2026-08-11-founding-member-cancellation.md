# Founding Members can cancel again

**Date:** 2026-08-11

## What was broken

No Founding Member could cancel their subscription. The API returned a Stripe
error:

> The subscription is managed by the subscription schedule `sub_sched_...`, and
> updating any cancelation behavior directly is not allowed. Please update the
> schedule instead.

Founding Members get a two-phase Stripe subscription schedule attached right
after checkout — their introductory price for one term, then standard pricing.
That schedule is what makes the launch offer expire correctly, but Stripe treats
a schedule as the owner of the subscription's lifecycle, and refuses any attempt
to set cancellation behaviour on the subscription directly while one is attached.

`POST /user/subscription/cancel` did exactly that, so the call was rejected
outright. Not a race, not an edge case at a period boundary — a hard failure for
every Founding Member, every time. Ordinary subscribers were never affected,
because they have no schedule.

## What changed

Cancellation now releases the schedule before setting `cancel_at_period_end`.
Releasing is not itself a cancellation: it leaves the subscription exactly as it
is and only detaches the remaining phases. For a subscriber with no schedule
attached it's a no-op.

Reactivation re-attaches the founding schedule after clearing the flag. Without
that, a Founding Member who cancelled and changed their mind would have kept the
introductory price indefinitely, since the rollover phase was released away when
they cancelled. The order matters in both directions:

- **Cancel**: release, *then* set the flag — the flag can't be set while managed.
- **Reactivate**: clear the flag, *then* re-attach — a schedule created from a
  subscription inherits its cancellation behaviour, so attaching first would bake
  the cancellation into the new schedule.

The schedule logic moved out of `webhooks.service.ts` into a new
`services/subscriptions/schedules.service.ts`. Both ends need it now — checkout
wiring a schedule up, cancellation tearing it down — and having the cancellation
path import the webhook service to reach it had the dependency the wrong way
round.

## Non-obvious decisions

**The schedule id is read from Stripe, not stored.** Stripe's docs recommend
storing schedule ids alongside the subscription, which would have meant a
migration and a new column to keep in sync. The subscription object already
carries a `schedule` field, and it is authoritative — it's null the moment a
schedule is released, which is exactly the question being asked. One extra
`retrieve` on a rare user action is cheaper than a column that can drift.

**A failed release is fatal to the cancellation; a failed attach is not.**
`releaseFrom` rethrows, because if it fails the cancellation cannot go through,
and reporting success would tell a user they've stopped paying while Stripe
carries on billing them. `attachFounding` swallows and logs, because the customer
is already paying and must not be left un-entitled over a future price rollover —
the daily reconciliation surfaces any that didn't take. That asymmetry is
deliberate.

**Cancellation is still period-end only.** Unchanged, and confirmed against the
Stripe docs while investigating: setting a custom cancel date rules out refunds
and forces prorations.

## Out of scope

- Capturing *why* a user cancelled (`cancellation_details.feedback`). Worth doing
  before launch, but it's a feature, not part of this fix.
- Account deletion still doesn't cancel the Stripe subscription — a deleted user
  keeps being billed. Separate bug, tracked separately.

## How it was verified

`src/__tests__/subscription-cancel.test.ts` grew from 11 to 14 cases. The
original file had a single fixture with `isFoundingMember: false` and a Stripe
mock whose `update` always succeeded, which is why this shipped: the broken path
had no coverage at all. Added a `FOUNDING` fixture plus cases pinning that
release happens before the update, that the release failure aborts rather than
reporting success, that ordinary subscribers touch no schedule API, and that
reactivation re-attaches in the right order.

14 passing, `tsc --noEmit` clean, full suite 225 passing. Three failures in
`subscription-pricing.test.ts` are pre-existing and unrelated — that file spreads
the real `.env` into its fixtures, so its "no founding window configured" cases
inherit `FOUNDING_OFFER_ENDS_AT=2026-11-01` and fail until that date passes.
