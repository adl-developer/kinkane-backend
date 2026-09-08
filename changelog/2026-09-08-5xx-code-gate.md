# Only surface a 5xx to the client when it carries a machine-readable code

**Date:** 2026-09-08
**Commit:** [e35e611](https://adl.github.com/adl-developer/kinkane-backend/commit/e35e61102a79f3cc2ccf8864593f4eac63140b86)

## What changed

The global Express error handler in `src/app.ts`, and the
`wrapHttp` helper in `src/lib/route-helpers.ts`, now treat 5xx errors
differently from 4xx errors:

- **4xx tagged errors** — surface as before. Anything a service threw
  with a `statusCode` in the 400–499 range still reaches the client with
  its message intact ("You already have this in your cart").
- **5xx tagged errors** — surface **only** when a `code` field is also
  set. Curated failures like `PARCEL_TOO_HEAVY` or `FX_UNAVAILABLE`
  therefore still surface with the intended message and machine-readable
  code. A 5xx tagged with no `code` falls through to the generic
  `500 Internal Server Error` handler, which returns the fixed
  `"Internal server error"` body and keeps the underlying message out of
  the response.

Every existing site that throws a 5xx has been given a matching `code`, so
no client-visible message changes with this commit. The new codes are:

| Site                                                   | `code`                          | Status |
|--------------------------------------------------------|---------------------------------|--------|
| `lib/money.ts` (missing FX rate, both directions)      | `FX_UNAVAILABLE`                | 503    |
| `services/commerce/pricing.ts` (`fxRateFor`)           | `FX_UNAVAILABLE`                | 503    |
| `services/commerce/pricing.ts` (`quoteShipping`)       | `SHIPPING_NOT_CONFIGURED`       | 503    |
| `lib/stripe.ts` (`assertStripeConfigured`, `stripe()`, `resolvePrice`) | `PAYMENTS_UNAVAILABLE` | 503    |
| `services/subscriptions/checkout.service.ts`           | `STRIPE_NO_URL`                 | 502    |
| `services/subscriptions/schedules.service.ts`          | `SCHEDULE_PHASE_INDETERMINATE`  | 502    |
| `services/subscriptions/webhooks.service.ts`           | `STRIPE_WEBHOOK_NOT_CONFIGURED` | 503    |

## Why

The design intent was that a `statusCode` tag opts an error into being
surfaced to the client — a way for services to raise "parcel too heavy"
as a `503` with a human-readable message rather than a bare 500. But
nothing in the handler enforced that the message was actually safe to
show.

A stray `throw Object.assign(stripeErr, { statusCode: 503 })` — either by
accident, or in a future patch that wraps a raw Stripe or database error
— would have leaked whatever text lived on the underlying error object
straight to the client. That's how endpoint fragments, request ids, or
provider-specific error strings end up in a mobile app's error dialog.

Requiring `code` alongside `statusCode` turns "surface this 5xx" into an
explicit, auditable decision. Grepping for the code names lists every
curated failure the client can see; anything else is safely masked as a
generic 500.

## Non-obvious decisions

- **4xx behaviour is untouched.** A tagged 4xx surfaces with or without a
  `code` — a 400 message is client-shaped by definition, and requiring a
  `code` for every 400 would be busywork.
- **`wrapHttp` mirrors the same gate.** Some routes reach the client
  through `wrapHttp` rather than the global handler, so the same rule
  lives in both places. Otherwise a raw 5xx thrown inside a
  `wrapHttp`-wrapped route would still leak.
- **Logs at warn, unchanged.** A curated 5xx is still logged at `warn`
  with `statusCode`, `code`, message, and request id, so operators can
  see them going out. A masked 5xx (no `code`) is logged at `error` by
  the generic-500 path with the full stack — same as any other unhandled
  error.
- **Existing sites updated in the same commit.** So no client sees a
  message change: the ones that already surfaced still do, with the same
  text; the new `code` field is additive on the JSON response.

## Verified

- TypeScript compilation clean (`npx tsc --noEmit`).
- Every existing 5xx-throwing site in the codebase was located and
  updated to carry a `code` — `FX_UNAVAILABLE`, `PAYMENTS_UNAVAILABLE`,
  `STRIPE_NO_URL`, `SHIPPING_NOT_CONFIGURED`,
  `STRIPE_WEBHOOK_NOT_CONFIGURED`, and `SCHEDULE_PHASE_INDETERMINATE`.
  No 5xx thrower remains without a matching `code`, so nothing that used
  to reach the client now stops doing so.
