# Email verification switches from a link token to a 6-digit OTP

**Date:** 2026-07-21

## What changed

`POST /api/v1/auth/verify-email` no longer takes a `token` copied from a
link in the verification email. It now takes a 6-digit `otp` the user types
back into the app, and **requires the user to be logged in** — the request
must include `Authorization: Bearer <accessToken>`.

```
POST /api/v1/auth/verify-email
Authorization: Bearer <accessToken>
Body: { "otp": "123456" }
```

The verification email itself now displays the 6-digit code directly
instead of a clickable "Verify Email" button/link.

Signup and `POST /api/v1/auth/resend-verification-email` behave the same as
before from the caller's perspective — they still trigger sending a
verification email, just with a code instead of a link. The code now
expires in **15 minutes** (previously the link was valid for 24 hours).

## Why

A raw 40-byte token is unguessable on its own, so the old design let the
token itself be the sole credential — no login required to redeem it. A
6-digit code is only a 1,000,000-value space, which is not safe to treat
the same way: anyone who could guess or brute-force a code could verify an
arbitrary account. So the endpoint now requires the caller to already be
authenticated, and the OTP is looked up scoped to that user's ID, never by
value alone — the same pattern already used by the email-change OTP flow
(`email-change.service.ts`). This is also why the expiry dropped from 24
hours to 15 minutes: a code meant to be typed back in while looking at the
email doesn't need the same shelf life as a link.

## Data model

`email_verification_tokens.token_hash` (unique) is renamed to `otp_hash`
and the unique constraint is dropped — a 6-digit code can legitimately
collide across different users' in-flight requests, unlike a 320-bit random
token. See `drizzle/0021_huge_blindfold.sql`.

## Rate limiting

`verifyEmailLinkLimiter` (20/hour/IP, sized around the old token being
unguessable) is replaced by `verifyEmailOtpLimiter` (10/hour, keyed by
authenticated user ID) — since the route now requires auth, this is a real
brute-force guard on the 6-digit space rather than just IP-shared-traffic
absorption.

## Scope

Only the verify-email endpoint, its schema column, rate limiter, and email
content changed. `resend-verification-email` still works the same way
(issues a fresh code, same auth requirement it already had). No changes to
signup, login, or other auth flows.

Out of scope: the mobile/frontend client, which isn't in this repo. It
currently reads `?token=` from the emailed link and needs to change to a
screen where the (already logged-in) user types in a 6-digit code instead.

## Verification

- `npx tsc --noEmit` passes with no errors.
- `drizzle-kit generate` produces a single migration
  (`0021_huge_blindfold.sql`) with exactly the expected rename + drop-unique
  statements — no other schema drift.
