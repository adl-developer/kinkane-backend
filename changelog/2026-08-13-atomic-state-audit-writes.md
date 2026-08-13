# Let state updates and their audit rows commit together

**Date:** 2026-08-13
**Commit:** [1261246](https://adl.github.com/adl-developer/kinkane-backend/commit/1261246f44336d293a61893995edc92dd5f29c2b)

## What changed

`subscriptionStateService.applyState` now accepts an `inSameTx` callback that
runs inside the same database transaction as the state update and its
history row. Callers use it to write an audit row (a cancellation reason, a
renewal event, a "plan changed" marker) that must live or die with the
state change it describes.

This is a plumbing change on its own — the six flows that actually use the
new hook are wired up in commit `9310c44`.

```ts
export interface ApplyStateOptions {
  // ...
  /**
   * Side effects that must succeed or fail together with the state write.
   * Runs inside the same transaction as the row update and history insert,
   * only when the state write actually happened (guards matched).
   */
  inSameTx?: (tx: DbHandle, updated: UserSubscription) => Promise<void>;
}
```

## Why

Applying a subscription state change and recording the audit event that
explained it used to be two separate database writes. A crash between them
left the subscription row moved on with no matching entry in the events
ledger — the cancellations report would be missing users who had cancelled,
the renewals ledger would be missing renewals that had happened, and
nobody would know.

Doing both writes in one transaction is the only way to guarantee they
either both land or neither does.

## Non-obvious decisions

- **Only runs when the state actually changed.** `applyState` returns `null`
  when its guards (`expectStatus`, `expectNoStripeSubscription`) don't match
  and nothing is written. The callback is skipped in that case — no state
  change means there's nothing to audit alongside.
- **A throw rolls the whole thing back.** The audit row failing takes the
  state write down with it. That's the point: better to have Stripe redeliver
  the webhook than to keep a state change without its audit trail.
- **Email/Redis stay outside the transaction.** Any callers doing those
  intentionally keep them after `applyState` returns — a Redis blip must not
  roll back a Stripe-driven state change we've already committed to.

## Verified

TypeScript compilation clean. Existing unit tests still pass — no observable
behaviour changed on the callers that haven't been migrated yet; the new
callback path is exercised by the follow-up commit (`9310c44`) that moves
every webhook and cancellation over to it. End-to-end confirmation of the
tx rollback semantics is left for staging verification alongside those
handler changes.
