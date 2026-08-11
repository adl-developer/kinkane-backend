# Let subscribers switch plans and give a reason when cancelling, in-app

**Date:** 2026-08-11

## What changed

Kinkané Plus subscribers can now switch between Monthly and Annual, or
downgrade to Free, from inside the app — `POST /api/v1/user/subscription/change`
— instead of the only options being "stay on this plan" or "cancel entirely."
The switch is confirmed with the account password (the same way account
deletion already is) and always takes effect at the end of the current
billing period, never immediately or prorated:

```json
// POST /user/subscription/change
{ "plan": "monthly" | "annual" | "free", "password": "..." }

// 200
{
  "currentPlan": "annual",
  "pendingPlan": "monthly",
  "effectiveAt": "2026-09-01T00:00:00Z",
  "tier": "plus",
  "status": "active"
}
```

`plan: "free"` is the existing cancel flow under this endpoint — the Change
Plan screen's "Free Plan" option, reached with a password rather than a
cancellation reason.

Cancelling (`POST /user/subscription/cancel`) now requires a reason instead
of nothing:

```json
{ "reason": "not_using" | "accidental" | "too_expensive" | "other", "reasonOther"?: "..." }
```

`reasonOther` is required when `reason` is `"other"`, max 500 characters.
The human-readable reason is written straight onto the existing
`subscription_events.reason` column (already free text, already used for
things like "Price changed from X to Y" — no new column needed for this
part).

Both were built to match the Figma "Manage your plan" flow: a plan picker
confirmed by password, and a cancellation reason survey confirmed by a
plain "are you sure" modal with no password step.

The Stripe Billing Portal endpoint (`POST /user/subscription/portal-session`)
has been removed. It previously existed for cancel, plan switches, card
updates and invoice history; cancel and plan switches now happen entirely
in-app, so the portal handoff no longer serves any billing action Kinkané
actually uses it for. Card updates and invoice history are not replaced —
see "Out of scope" below.

## API / data shape

One migration, adding a single nullable column to two tables:

- `user_subscriptions.pending_plan` — the plan a schedule is currently
  targeting, or `null` if nothing is pending.
- `subscription_state_history.pending_plan` — mirrored for consistency with
  every other column on that table.

No separate "effective at" column: the effective date is always the
existing `current_period_end`, so a second column would just duplicate it.

`GET /user/subscription` and `GET /user/subscription/history` both now
return `pendingPlan`, which is what lets "Manage your plan" render "Annual
Plan, ending {date} / Monthly Plan, starting {date}" from a normal page
load — no live Stripe call on that path.

## Non-obvious decisions

**A plan change is a Stripe subscription schedule, reusing the exact
mechanism the Founding Member price rollover already uses**
(`schedulesService.attachFounding`). Two phases: the current price for the
rest of the current term, then the destination plan's price, open-ended,
`end_behavior: 'release'`. Because Stripe allows only one schedule per
subscription, requesting a plan change while a Founding Member's rollover
schedule is still active rewrites that same schedule's final phase rather
than creating a second one — the founding-term phase is left untouched, only
where it rolls onto afterward changes.

**A plan change always lands on standard pricing for the new plan, even for
a Founding Member still inside their locked-in term.** The founding rate
does not carry over to a different plan; it stays attached to the plan they
originally bought.

**No new webhook handling was needed.** `onSubscriptionChanged` already
detects a price change generically by comparing the incoming price against
what's stored, so a schedule phase advancing just looks like any other
Stripe-side price change. The only addition there is clearing `pendingPlan`
once no schedule is left managing the subscription (`scheduleIdOf(subscription)`
is `null`) — covering both "the change took effect" and "it was abandoned
by a cancel or another change elsewhere," without needing to distinguish
which.

**Cancelling clears any pending plan change.** `releaseFrom` already detaches
the schedule as part of cancellation; `pendingPlan` is set back to `null` in
the same `applyState` call so the stored state doesn't claim a switch is
still coming when Stripe no longer has any schedule to deliver it.

**Change Plan is blocked while a cancellation is pending** (`409
PENDING_CANCELLATION`) — a schedule that's simultaneously mid-price-change
and mid-cancellation is an ambiguous state Stripe has no clean way to
express; the user has to reactivate first.

**The cancellation reason is written locally, before the webhook arrives**,
the same "mirror now, let the webhook agree later" pattern the rest of this
subsystem already uses for state. This also means `onSubscriptionChanged`'s
existing generic `'cancelled'` event insert doesn't fire a second time for
the same transition — by the time that webhook lands, `cancelAtPeriodEnd`
is already `true` locally, so its own "just started cancelling" check is
false.

**`authService.verifyPassword` was extracted from `deleteAccount`** into a
shared helper, now used by both. Behaviour is unchanged; it's the same
`bcrypt.compare` against `users.passwordHash`, with the same 400 for
social-login accounts that have no password.

## What's explicitly out of scope

- **Card updates and invoice/receipt history.** These were the other two
  things the now-removed Billing Portal covered, and neither is replaced.
  Rebuilding them in-app means reimplementing SCA and the invoice PDF flow,
  which stays out of scope until there's a reason to prioritise it.
- **Immediate/prorated plan changes.** Every switch — upgrade or downgrade —
  waits until the current period ends. No proration math anywhere in this
  change.
- **A DB enum for cancellation reasons.** `reason` stays a plain
  human-readable string on `subscription_events`, matching how every other
  `reason` column in this codebase already works (free text, not enum +
  lookup table).

## How it was verified

`npx tsc --noEmit` and `npm run build` clean. Migration generated, reviewed
(exactly the two intended nullable columns, nothing else), and applied to a
local database — confirmed present via a direct query against
`information_schema.columns`.

No existing test suite covers Stripe webhook/schedule flows end-to-end, so
this was verified by tracing each code path against the actual Stripe API
semantics (schedule phase replacement, `release`'s detach behaviour) rather
than a live Stripe test-mode run. Recommended before shipping: exercise the
full loop in Stripe test mode — request a change, confirm the schedule in
the Stripe dashboard, let a test clock advance the phase, confirm the
webhook updates `pending_plan` back to `null`.
