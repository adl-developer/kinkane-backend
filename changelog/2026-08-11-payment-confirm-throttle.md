# Payment confirmation is now throttled

**Date:** 2026-08-11

## What changed

`GET /api/v1/payments/:reference` is now rate limited to **60 requests per
minute per user**. Over that, it answers 429 with the standard body:

```json
{ "error": "Too many requests — please try again later" }
```

Nothing else about the endpoint changes.

## Why

This endpoint is designed to be polled. The client returns from Stripe's hosted
page before the webhook has arrived, so it sits on a "confirming your payment"
spinner and asks repeatedly until the answer settles. That is the intended use,
and 60/minute is deliberately generous enough for a one-second poll with room to
spare.

The reason it needs a ceiling at all is what happens on a *pending* payment.
The confirm path falls through to a live Stripe API call
(`checkout.sessions.retrieve`) whenever our own record is still pending, guarded
by a 2-second re-check window stored on the payment row:

```ts
const checkedRecently =
  row.lastCheckedAt !== null && Date.now() - row.lastCheckedAt.getTime() < RECHECK_INTERVAL_MS;
```

That guard is written *after* the Stripe call returns. Two requests arriving
inside the same window both read `lastCheckedAt` as stale, and both start their
own Stripe request before either one records the attempt. The row-level guard
collapses a *sequential* poll loop, which is what it was written for, but it
does not bound *concurrent* ones — and a native app retrying on a flaky
connection, or a user with the confirmation screen open on two devices, produces
exactly that shape.

The limiter is the outer bound the row guard cannot provide.

## Why not tighten the row guard instead

Moving the stamp before the Stripe call, or replacing it with a Redis `SET NX EX`
lease, would close the race more precisely. Both were rejected for now:
stamping early means a failed Stripe call suppresses the retry that should
follow it, and a Redis lease puts a second dependency in front of a screen whose
whole job is to answer "did my money go through". A request ceiling is cruder
but it degrades in the right direction — a 429 tells the client to back off,
which is what we want it to do anyway.

## Verified

Limiter registered on the route ahead of the handler; type-checked against the
existing limiter definitions, which it matches in shape (same 429 handler, same
Redis store, same user-keyed generator).
