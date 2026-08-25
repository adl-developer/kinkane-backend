# Keep founding members on their founding price for every renewal

**Date:** 2026-08-13
**Commit:** [445e499](https://adl.github.com/adl-developer/kinkane-backend/commit/445e499c6c1745aac2b6a18742a0c187b53e2cf7)

## What changed

Founding-member pricing now sticks until BOTH the launch offer window has
closed AND the founding member's current billing period has ended.
Whichever finishes later is when they roll onto standard pricing.

Three concrete changes:

1. **No schedule at signup.** The subscribed-webhook no longer attaches a
   founding-to-standard rollover on checkout. Founding pricing continues on
   every renewal for free while the window is open.
2. **Rollover attached from `invoice.paid`.** A new
   `schedulesService.scheduleFoundingRollover` runs after every renewal
   invoice is paid. If the subscriber is a founding member, was billed at
   a founding price, and the offer window has closed, it schedules the
   rollover so the *next* renewal moves them to standard. Guarded so it's
   a no-op for anyone else and safe to run every renewal.
3. **Plan changes inside the window keep founding.** A new
   `pickTargetPriceId(plan, isFoundingMember)` helper resolves the target
   price for a plan switch: while the window is open, founding members
   get the founding price of the new plan. Switching monthly to annual
   mid-window no longer quietly forfeits the founding rate.

Two related fixes to schedule handling:

- **Reactivation on a founding member** now reattaches the rollover only
  when the window has already closed — otherwise the founding rate
  continues without any schedule, and the rollover gets attached later
  by `invoice.paid` when the window actually shuts.
- **Undoing a pending plan change** (picking the current plan again in
  the Change Plan menu) detaches the entire schedule via `releaseFrom`,
  which used to also drop the founding rollover with nothing to replace
  it. It now reattaches the rollover immediately when the user is a past-window
  founding member.

## Why

Founding members were being rolled to standard pricing after their first
term, regardless of whether the offer window was still open. That was
wrong on two counts:

- Someone who signed up on day one of the launch and paid for a monthly
  plan lost the founding rate after 30 days, even if the offer had months
  left to run.
- Someone who switched from monthly to annual halfway through the offer
  window lost the founding rate on the annual plan, because the switch
  targeted standard pricing.

Both broke the promise made at signup that founding pricing applied for
the whole offer, not just one billing term.

## Non-obvious decisions

- **Rollover is scheduled from `invoice.paid`, not on a timer.** Anchoring
  to the paid invoice means the rollover naturally fires at the next
  natural billing boundary, doesn't need a separate scheduler process, and
  is retried for free via Stripe's webhook redelivery if the initial
  attempt fails.
- **`schedulePlanChange` now preserves all past and current schedule
  phases exactly.** Rewriting the current phase would cause Stripe to
  pro-rate the switch and bill the new plan mid-cycle, which is not what
  users asking to change plan expect. Only future phases can be replaced.
- **A between-phases state throws a `409`.** If the schedule has no active
  phase (Stripe should have released it), the code refuses to write rather
  than guess. Better to surface an unusual state than to write something
  we can't reason about.
- **No backfill for existing subscribers whose 1-term rollover already
  fired.** Those users are already on standard pricing and undoing that
  is a support-ticket decision, not an automated one. Subscribers still
  on their first term will get the corrected behaviour going forward.

## Verified

TypeScript compilation clean. The existing `subscription-cancel.test.ts`
suite passes after its mock was updated to expose `isFoundingPriceId`
(previously not needed) — the founding-schedule reattach cases still
produce the same Stripe API calls, in the same order, that the tests
pin.

**Explicitly not verified in this branch:**

- End-to-end Stripe schedule behaviour against a live account — no
  test-mode Stripe listener runs in this environment. Every Stripe call
  is issued through `stripe()` and its shape follows the SDK's TypeScript
  types.
- The `subscriptionSchedules.update` call in `schedulePlanChange` sends
  the full phases array including any past phases exactly as-is; if
  Stripe rejects that shape at scale, it would surface as a synchronous
  error rethrown from `changePlan`. Worth exercising against a staging
  Stripe account with a founding subscriber before rollout.
- Existing subscribers whose 1-term rollover already fired are
  unaffected by this change. No backfill for them — undoing that would
  be a support decision, not automated.
