# Subscription checkout now returns its real error codes instead of 500

**Date:** 2026-08-11

## What changed

Three subscription endpoints were answering `500 {"error":"Internal server
error"}` for every failure, including the ordinary, expected ones they were
designed to return:

| Endpoint | Was | Now |
| --- | --- | --- |
| `POST /api/v1/user/subscription/checkout-session` | 500 | 409 already subscribed, 404 no subscription/user, 400 bad `successUrl`/`cancelUrl` origin, 502 no Stripe URL, 503 payments off |
| `POST /api/v1/user/subscription/portal-session` | 500 | 404 no billing account, 400 bad `returnUrl`, 503 payments off |
| `GET /api/v1/user/subscription/plans` | 500 | 503 payments off |

The response body now carries the service's own message (and `code`, where one
is set) rather than a generic string — so a user who already has Plus and taps
Subscribe again gets "You already have an active Kinkané Plus subscription"
with a 409, which the client can render, instead of an unexplained 500.

Nothing about the success path changes, and no status code that was already
correct has moved.

## Why it happened

Services in this codebase signal expected failures by throwing an `Error` with a
`statusCode` attached. Two route wrappers exist in
[route-helpers.ts](../src/lib/route-helpers.ts): `wrap`, which is just
`.catch(next)`, and `wrapHttp`, which reads that `statusCode` and turns it into
the response.

The guard itself was always right —
[checkout.service.ts](../src/services/subscriptions/checkout.service.ts) throws a
409 when the user already has a live `stripeSubscriptionId`, specifically so a
second checkout never creates a second Stripe subscription for one person. But
the route was registered with `wrap`, so the error went to the global handler in
[app.ts](../src/app.ts), which answers 500 for anything that is not a JSON syntax
error. `/cancel` and `/reactivate` were already on `wrapHttp`; these three were
missed.

Worth noting as the shape of the bug rather than the bug itself: the two wrappers
are one character apart at the call site and both compile, so nothing flags the
wrong one. The route docblocks had documented the correct codes (409 already
subscribed, 503 payments not configured) since they were written — the contract
was right and only the wiring was wrong, which is why this survived review.

## How it is fixed

`wrap` → `wrapHttp` on the three routes in
[subscriptions.routes.ts](../src/routes/subscriptions.routes.ts). No service,
controller or schema changed.

`wrapHttp` still forwards anything without a `statusCode`, or with a 5xx one, to
the global handler untouched, so genuine unexpected failures keep their stack
trace and their generic client-facing message. A Stripe API outage still reads as
a 500; only the deliberate, documented failures are now distinguishable from it.

`GET /` and `/history` deliberately stay on `wrap`: neither throws a
`statusCode`-bearing error — `/` returns its 404 by writing the response
directly, and `/history` has no failure mode of its own.

## Left out of scope

No route-level test covers the 409-on-repeat-checkout path; the existing
subscription suites test the services directly. Adding request-level coverage for
these three endpoints would have caught this and is worth doing, but it is a
larger change than the fix and is not included here.

## How it was verified

`tsc --noEmit` clean. The three subscription and payment suites
(`subscription-cancel`, `payment-status`, `commerce-pricing`) pass — 61 tests, 3
files, no failures. Those suites exercise the services rather than the routes, so
they confirm the change breaks nothing; they do not themselves assert the new
status codes, per the scope note above.
