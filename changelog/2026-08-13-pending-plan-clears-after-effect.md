# Stop the account screen showing a plan change that has already happened

**Date:** 2026-08-13
**Commit:** [d75a761](https://adl.github.com/adl-developer/kinkane-backend/commit/d75a76118dd83d4e72f4db2fc552a6910ab07343)

## What changed

The subscription-update webhook now clears the `pendingPlan` field on the
user's subscription row when the current plan already matches the pending
one — not just when Stripe has released the price schedule.

```ts
const scheduleId = scheduleIdOf(subscription);
const pendingPlanCleared =
  plan && existing?.pendingPlan && plan === existing.pendingPlan;
const nextPendingPlan =
  !scheduleId || pendingPlanCleared ? null : undefined;
```

`undefined` still means "leave whatever's already stored alone" (this
generic handler didn't set it in the first place); `null` explicitly clears
it.

## Why

A user who scheduled a switch from monthly to annual would see a "pending
change to Annual" banner on the account screen forever after the switch
actually took effect. The old logic only cleared `pendingPlan` when Stripe
released the price schedule — and Stripe only releases a schedule when its
last phase ends. A monthly-to-annual rollover schedule's last phase is
open-ended, so it never ends, so `scheduleId` kept coming back non-null
forever, so `pendingPlan` was never cleared.

The banner said something that wasn't true, and the only fix for the user
was to run the plan change again — which of course did nothing, since
they were already on it.

## Non-obvious decisions

- **Two independent clearing conditions, either sufficient.** Schedule
  released (`!scheduleId`) still clears it — that's the case for a change
  the user cancelled, or a founding rollover that finished. The new case,
  current plan matching pending plan, covers the schedule-is-still-there
  scenario.
- **No migration for existing stuck rows.** The next `customer.subscription.updated`
  webhook for each affected user will land through this code path and clear
  the flag naturally. Stripe emits one for anyone whose plan or period
  changes, so the drift heals as users are billed. No manual sweep needed.

## Verified

TypeScript compilation clean. The clearing rule follows directly from the
two additions in `onSubscriptionChanged`:

```ts
const pendingPlanCleared = plan && existing?.pendingPlan && plan === existing.pendingPlan;
const nextPendingPlan = !scheduleId || pendingPlanCleared ? null : undefined;
```

Any webhook where `plan` equals `existing.pendingPlan` produces
`nextPendingPlan: null`, which then flows through `applyState` to clear
the column. Staging replay of the actual switch is left for rollout.
