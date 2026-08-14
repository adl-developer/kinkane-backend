# Keep a cart's timestamp in step with its line changes

**Date:** 2026-08-13
**Commit:** [f623b4b](https://adl.github.com/adl-developer/kinkane-backend/commit/f623b4b8865a2bf214492beac055e303f5805747)

## What changed

The four cart mutation paths — add item, update quantity, remove item,
clear cart — used to write the line change and then, in a separate call,
bump `carts.updatedAt` via a `touch()` helper. Each is now wrapped in a
single transaction so both writes commit together, and the standalone
`touch()` helper is gone.

```ts
await db.transaction(async (tx) => {
  await tx.delete(cartItems)
    .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.bookId, bookId)));
  await tx.update(carts).set({ updatedAt: new Date() })
    .where(eq(carts.id, cart.id));
});
```

## Why

A crash between the two writes left the cart's own `updatedAt` older than
its newest line — throwing off the "recently modified" ordering the
timestamp exists for in the first place. Every path that changes the
cart's contents needs the cart's timestamp to move with them.

## Verified

TypeScript compilation clean. The change is a mechanical wrap of two
existing writes in `db.transaction`; the behaviour on both success and
failure follows from Drizzle's transaction semantics, which the rest of
the codebase already relies on for the auth and subscription paths.
