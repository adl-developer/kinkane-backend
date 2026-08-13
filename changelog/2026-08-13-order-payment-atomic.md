# Keep the order and its payment record in step with each other

**Date:** 2026-08-13
**Commit:** [3e739ad](https://adl.github.com/adl-developer/kinkane-backend/commit/3e739adcb15e4f7d1c99babce2cf529aed09ce5f)

## What changed

The book-checkout flow used to make two separate database calls once
Stripe returned a checkout session:

1. Update the `orders` row with `stripe_checkout_session_id`.
2. Insert a `payments` row keyed on that same session id.

Both now happen inside a single transaction. `paymentsService.create`
takes an optional `tx` handle so the caller can enlist it in an
already-open transaction:

```ts
const payment = await db.transaction(async (tx) => {
  await tx
    .update(orders)
    .set({ stripeCheckoutSessionId: session.id, updatedAt: new Date() })
    .where(eq(orders.id, order.id));

  return paymentsService.create({ ...paymentFields }, tx);
});
```

## Why

If the process crashed between the two writes, one of two half-states was
possible:

- **Order updated, payment missing.** Stripe's webhook could correlate its
  event back to the order (session id was set), but the buyer's
  confirmation screen — which looks up the payment reference — showed
  "payment not found" for a checkout that in fact went through.
- **Payment inserted, order not updated.** The reference in the buyer's
  hand pointed at a payment row whose order had no session id, so the
  webhook couldn't find its way home.

Both writes belong to the same "checkout succeeded" event, so they should
commit as one.

## Non-obvious decisions

- **`paymentsService.create` accepts an optional `tx`, not required.** The
  subscription checkout flow doesn't need the transaction — it only writes
  the payment row. Keeping `tx` optional means the two callers share one
  function without the subscription path taking on a needless transaction
  overhead.
- **`paymentsService.create` is still idempotent on session id.** If a
  Stripe API call succeeds but the follow-up transaction retries at the
  application layer (unlikely, but possible), the second attempt finds the
  existing payment row rather than minting a duplicate.

## Verified

TypeScript compilation clean. `paymentsService.create` now accepts an
optional `tx` handle and threads it through both the SELECT-for-existing
and INSERT paths, so a rollback of the outer transaction rolls both back
together — same pattern the auth service already uses for its own
transaction-threaded helpers. End-to-end confirmation against a real
Stripe session is left for staging.
