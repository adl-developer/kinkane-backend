# Keep every subscription state change and its audit row in one transaction

**Date:** 2026-08-13
**Commit:** [9310c44](https://adl.github.com/adl-developer/kinkane-backend/commit/9310c44622cd4b26c59bdb942b13c65a6ab8a249)

## What changed

Six subscription flows used to write their audit row as a separate
`db.insert` after `applyState` returned. They now hand the insert to
`applyState`'s new `inSameTx` callback (see commit `1261246`), so the state
change and the event row commit together or not at all.

Affected flows:

1. **Checkout completed** — the `converted` event that records the sign-up.
2. **Plan change webhook** — the `plan_changed` event for a price switch.
3. **Started cancelling** (from webhook) — the `cancelled` event for a
   period-end cancellation.
4. **Resumed** (from webhook) — the `resumed` event when a cancellation is
   reversed before the period ends.
5. **Subscription deletion** — the terminal event that clears the row.
6. **User-initiated cancel** — the `cancelled` event with the reason.

Example (checkout):

```ts
await subscriptionStateService.applyState(userId, {...}, {
  reason: 'checkout_completed',
  sourceEventId: event.id,
  inSameTx: async (tx) => {
    await tx.insert(subscriptionEvents).values({
      userId,
      event: 'converted',
      amountCents: session.amount_total,
      currency: session.currency,
      stripeEventId: event.id,
      reason: isFounding ? 'Founding Member checkout' : 'Checkout completed',
    });
  },
});
```

## Why

The two writes describing the same event lived in the same function but not
the same transaction. A crash between them (rare, but Stripe replays
frequently enough that it does happen) kept the subscription row's new
state and silently dropped the record that explained why.

The visible consequences were two lied-to reports:

- The **cancellation reasons report** was missing users who had cancelled
  but crashed before the reason row wrote.
- The **renewals ledger** was missing renewals that had otherwise
  succeeded.

Nothing pointed at the drop — the reports just came out slightly short.

## Non-obvious decisions

- **Email stays outside the transaction.** Enqueueing the cancellation
  email is a Redis write, and a Redis blip must not roll back the
  cancellation itself. If the enqueue fails the state change is still
  recorded and the log tells support what to do about it.
- **The user-cancel path (`checkout.service.cancel`) records the reason
  here even though `onSubscriptionChanged` will re-see the same transition
  from Stripe.** Both handlers write the state the event describes rather
  than a delta, so agreeing writes are the normal case; the "just started
  cancelling" branch in the webhook is a no-op when `existing.cancelAtPeriodEnd`
  is already true, so no reason-less duplicate is inserted.
- **`sourceEventId` still lives on the state history side.** The event row
  gets `stripeEventId` for its own idempotency; the two together let us
  trace every audit row back to the exact Stripe event that produced it.

## Verified

TypeScript compilation clean. Existing unit tests (240 passing) unchanged.
Each of the six migrated call sites moves an existing insert into the
`inSameTx` callback added by `1261246`, without changing the fields
written — atomicity follows from the shared transaction handle, and
audit-content parity is decidable by diffing the pre- and post-migration
inserts. End-to-end staging replay of a failing-audit-insert scenario is
left for rollout.
