# Finish paid orders even when the webhook has to be retried

**Date:** 2026-08-13
**Commit:** [1af0560](https://adl.github.com/adl-developer/kinkane-backend/commit/1af0560d7e312f35150b67f5332b604180fb1442)

## What changed

The Stripe order webhook used to gate its follow-up steps — clearing the
cart, recording purchase signals for the recommender, and queueing supplier
fulfilment — on the return value of `ordersService.markPaid`, only running
them when `markPaid` reported a first-time transition to `paid`.

That gate is now gone. All three follow-ups run every time the webhook
arrives for a paid order, because each one is already safe to repeat:

- **Cart convert** is a `WHERE status = 'active'` update — a no-op once the
  cart is already converted.
- **Purchase signals** use `onConflictDoNothing` — a repeated row is
  silently discarded.
- **Fulfilment enqueue** uses BullMQ's `jobId` deduplication — a second
  enqueue with the same id is dropped.

## Why

If the process crashed between `markPaid` succeeding and the follow-ups
running, Stripe's retry would find the order already in `paid` state and
`markPaid` would return `false`. The old code took that as "someone already
handled this" and returned. The cart stayed full of the books the user had
just bought, the recommender never learned about the purchase, and the
order was never sent to the supplier.

The retry mechanism only fixes crashes if the retry actually re-does the
work. This makes it do so.

## Non-obvious decisions

- **No transaction wrapping.** These three writes go to different backends
  (Postgres, Postgres, Redis/BullMQ). A single crash can still land only
  some of them — but each individual retry brings us strictly closer to
  fully complete, and each is idempotent, so redeliveries eventually
  converge without accidental duplication.
- **`markPaid`'s return value is still meaningful elsewhere.** We just
  don't need it here: the follow-ups are safe to run whether or not this
  particular delivery caused the state transition.

## Verified

TypeScript compilation clean. Each downstream call's idempotency is
demonstrable from the code:

- `ordersService.convertCart` uses `WHERE status='active'`, so a second
  call finds nothing to update.
- `interactionsService.record` (called by `recordPurchaseSignals`) uses
  `onConflictDoNothing` against a partial unique index.
- `enqueueFulfilment` uses BullMQ's `jobId: order-${orderId}` for
  built-in dedup.

Full end-to-end replay against a Stripe webhook simulator is left for
staging.
