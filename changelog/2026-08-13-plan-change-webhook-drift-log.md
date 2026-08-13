# Log a loud warning when a plan change races the webhook that mirrors it

**Date:** 2026-08-13
**Commit:** [2bdcf62](https://adl.github.com/adl-developer/kinkane-backend/commit/2bdcf629b7db0a472a29f50a3547c8e497f4d038)

## What changed

`checkoutService.changePlan` now emits an `error`-level log when the
local mirror write returns `null` — meaning something else (almost
always a webhook) moved the subscription row on between our
`getCurrent` read and our own `applyState` write.

```ts
if (!state) {
  logger.error(
    'Plan change written to Stripe but local state race prevented mirror',
    { userId, stripeSubscriptionId: sub.stripeSubscriptionId, toPlan: plan },
  );
}
```

Nothing rolls back and no error surfaces to the user. Stripe is the
source of truth: the schedule is already attached, so Stripe's next
`customer.subscription.updated` webhook will land shortly and reconcile
the local view with the correct `pendingPlan`.

## Why

The race is rare but real, and used to be entirely silent — the mirror
just returned without saying so. If it ever produced a support ticket
("I changed my plan and nothing shows on my account"), there was no
signal in the logs pointing at the plan-change endpoint being where the
delay originated.

Now the window between the Stripe write and the reconciling webhook is
findable by `userId` or subscription id, so a support ticket can be
tied back to the exact race, and if it starts happening more often
than expected the alert on error-level logs picks it up.

## Verified

TypeScript compilation clean. Log-only addition, no behaviour change on
the happy path — the guard is `if (!state)` after the existing
`applyState` call, which already handles `null` returns as a normal
outcome. Staging exercise of the race itself is not straightforward
without a specific fault-injection test; skipped as low-priority.
