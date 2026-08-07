# Removed the deprecated subscription upgrade endpoint

`POST /api/v1/user/subscription/upgrade` is gone. Clients start a subscription
through `POST /api/v1/user/subscription/checkout-session`, which has been the
real path since Stripe went in on 2026-08-02.

## What it was

Before Stripe, `/upgrade` was a stub: it ignored its body, took no payment, and
answered `{ status: 'pending' }`. When Stripe landed, it was kept as a thin
alias that created a genuine Checkout session but still returned that
`status: 'pending'` key, so a client built against the old contract wouldn't
break on a response shape it never read anyway. The Stripe write-up said to drop
it once the app shipped a version calling `/checkout-session`; that has happened,
so it's dropped.

## Why not keep it indefinitely

Two endpoints doing the same thing drift apart. The alias had already picked up
behaviour the real endpoint doesn't have, and none of it was better:

- **It couldn't reject a bad plan.** `/checkout-session` validates against
  `z.enum(['monthly', 'annual'])` and answers 400 with the offending field.
  `/upgrade` did `plan === 'annual' ? 'annual' : 'monthly'`, so a typo, a null,
  or a plan name we don't sell silently charged the user monthly. A caller
  trying to buy the annual plan and misspelling it got billed for the wrong one
  and a 200 saying everything was fine.
- **It couldn't return the user to where they started.** It accepted no
  `successUrl`/`cancelUrl` and always used the configured defaults, so anyone
  routed through it lost their place after checkout.

Neither was worth fixing in a duplicate of an endpoint we already have.

## Anything that still calls it

It now 404s. Nothing in this repo referenced it — no tests, neither Postman
collection, no other route — so the only possible callers are app builds
predating the `/checkout-session` migration. There is no app-version gate on the
API (no `X-App-Version` handling anywhere in `server/src`), so this could not be
done selectively: the shim was either served to everyone or to no one. A user on
a build old enough to call `/upgrade` now gets a 404 on the paywall's purchase
button rather than a Checkout page.

Pricing, the Founding Member window, the Billing Portal, and the Stripe webhook
are all untouched.

## Verified

`npx tsc --noEmit` passes. The removal is three deletions — the route
registration and its doc block in `src/routes/subscriptions.routes.ts`, and the
`upgrade` controller method in `src/controllers/subscriptions.controller.ts`.
No service, schema, or middleware changed; `checkoutService.createCheckoutSession`
keeps its one remaining caller.
