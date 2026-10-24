# App Store purchases verify before the app is live

## What changed

When the server checks an App Store purchase (`POST /api/v1/user/subscription/apple/verify`,
and App Store notifications), it asks Apple's Production API first and then
Sandbox. Until now it only moved on to Sandbox when Production said "no such
transaction" (404). It now also moves on when Production rejects our API key
(401), as long as sandbox purchases are allowed (`APPLE_IAP_ALLOW_SANDBOX`).

## Why

Apple's Production API answers 401 to a perfectly valid key until the app has
a version live on the App Store. Before launch, every purchase (TestFlight, App
Review, sandbox testers) is a sandbox one, but the server stopped at
Production's 401 and answered `503 APPLE_IAP_UNAVAILABLE` ("App Store rejected
our API credentials"). Checked against Apple directly with the production key:
Production 401, Sandbox 200 for the same transaction.

## Decisions

- A key that is genuinely wrong is still reported: Sandbox rejects it too, and
  that 401 is what the caller gets.
- With sandbox purchases switched off, a Production 401 is reported as before,
  without asking Sandbox.
- Other Production failures (5xx, network) still stop there as
  `APPLE_IAP_UPSTREAM`, so an outage isn't hidden behind a sandbox lookup.

## Verification

New `src/__tests__/apple-store.test.ts` stubs Apple per host and covers
Production success, 404→Sandbox, 401→Sandbox, 401 on both, 401 with sandbox
off, and a Production 500. The 401→Sandbox test fails without this change.
