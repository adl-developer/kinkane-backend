# One pending plan change at a time, with its own cancel

## What changed

- **New endpoint `DELETE /api/v1/user/subscription/change`** withdraws a
  pending plan switch. The user stays on their current plan and renews on it as
  before. It returns the same shape as `POST /change`, with `pendingPlan: null`.
- **`POST /change` now refuses while a switch is pending.** Every target plan,
  including `free`, gets `409 PLAN_CHANGE_PENDING`, and the body also carries
  `pendingPlan` and `effectiveAt` so the app can say "Cancel your pending switch
  to annual first."
- **`POST /cancel` is unchanged.** It still cancels the whole subscription at
  period end and clears any pending switch along the way.

## Why

Before this, a second change made while one was pending was handled
silently. Picking your current plan again quietly undid the switch, and
picking free quietly dropped it. The client wanted the user to deal with the
pending change explicitly before making another one.

## Decisions

- **Cancelling the subscription is not blocked.** Making someone cancel a
  pending switch before they can cancel their subscription would add a step on
  the way out, which app stores and UK subscription rules push against. And
  cancelling makes the pending switch meaningless anyway.
- **No password on `DELETE /change`.** It only restores what the user already
  had and moves no money. Changing plan still needs a password or a fresh
  sign-in.
- **Picking your current plan no longer undoes a switch.** That job moved to
  the new endpoint. The undo logic itself is unchanged: release the Stripe
  schedule, then put back a Founding Member's founding-to-standard switch, so
  the founding price still ends on time.
- **Apple subscribers** get `409 MANAGED_BY_APPLE`, the same as every other
  Stripe billing action.

## Billing

Nothing changes in how Stripe bills. A scheduled switch is a two-step Stripe
schedule, and Stripe charges the new price automatically at the next renewal.
Cancelling the switch removes the schedule, so the subscription renews on its
current price.

## Verification

Unit tests in `src/__tests__/subscription-cancel.test.ts` cover these cases:

- a second change (monthly, annual or free) is refused and nothing is written to Stripe
- `/cancel` still goes through while a switch is pending
- `DELETE /change` releases the schedule and clears `pendingPlan`
- `NO_PENDING_CHANGE`, a missing subscription row, and Apple-billed users

Typecheck and the full suite (1669 tests) pass. It has not been run against
Stripe's test mode.
