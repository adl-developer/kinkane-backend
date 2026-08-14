# Ask for a cancellation reason on every path that cancels

**Date:** 2026-08-13
**Commit:** [f1f8520](https://adl.github.com/adl-developer/kinkane-backend/commit/f1f85206a0e24b674209aa06742104919a1da93f)

## What changed

`POST /api/v1/user/subscription/change` now demands the same `reason` /
`reasonOther` fields that `POST /cancel` does — but only when the target
plan is `free` (which is the same underlying action as an explicit
cancel).

Reject rules on the change-plan body:

- `plan: 'free'` **without** a `reason` → `400`
- `reason: 'other'` **without** a `reasonOther` → `400`
- `plan: 'monthly' | 'annual'` **with** any reason fields → `400`
  (reason data only applies to cancellations)

The `checkoutService.changePlan` signature now takes `reason` and
`reasonOther`, forwarded through to `cancel(userId, reason, reasonOther)`.

## Why

Picking "Free Plan" from the Change Plan menu used to cancel the
subscription without ever asking why. Those cancellations were real
cancellations from the billing side but never appeared in the reasons
report — the report was silently missing every user who chose Free Plan
out of the Change Plan menu instead of hitting the dedicated Cancel
Subscription flow.

Cancellations should flow through the same reasons ledger regardless of
which button reached them, otherwise the report is a lie.

## Non-obvious decisions

- **Reason schema shared with `/cancel`.** Extracted the original schema
  as `cancelReasonSchema` and reused it via zod refinements on the
  change-plan body, so the two endpoints can't drift in what "a valid
  cancellation reason" means.
- **Reason is rejected on non-cancel plan changes.** Not silently
  ignored — a caller sending reason data for a monthly-to-annual switch
  is confused about which endpoint they're calling, and a `400` surfaces
  that at integration time.

## Verified

TypeScript compilation clean. The four validation refinements are pure Zod
schema rules; correctness is decidable from reading the schema, and the
matching test coverage on the surrounding change-plan controller
continues to pass. Runtime shape-check (405/400/200 on each combination)
is left for a request against staging before rollout.
