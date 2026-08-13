# Let social-login accounts change their plan with a fresh sign-in

**Date:** 2026-08-13
**Commit:** [1e69091](https://adl.github.com/adl-developer/kinkane-backend/commit/1e69091a33e4a6a64ae5eb9021b679b0e7e3f1a4)

## What changed

`POST /api/v1/user/subscription/change` now accepts a fresh Firebase ID
token as an alternative to the account password. Exactly one of the two
must be supplied:

```json
{
  "plan": "annual",
  "idToken": "<fresh Firebase ID token>"
}
```

- **Password accounts** still send `password`.
- **Social accounts** (Google, Apple — no password ever set) send
  `idToken` from a Firebase re-authentication performed within the last
  five minutes.
- Sending both, or neither, is rejected with `400`.

A new `authService.verifyOwnership({ password?, idToken? })` picks the
right check for the credential given. Under the hood
`verifyFreshIdToken` decodes the token, checks the `auth_time` claim
against a 5-minute freshness window, and confirms the provider UID
matches a `user_providers` row already linked to the caller's account.

## Why

Users who signed up with Google or Apple had no way to switch plans in
the app. The change-plan endpoint required a password they never set, so
the request was always rejected as "incorrect password". They had no
route out of their current plan without opening a support ticket.

## Data / API shape

The endpoint's new error surface:

- `400` — provide exactly one of `password` or `idToken`.
- `401` — invalid or expired sign-in token.
- `401` — the ID token is fine, but its `auth_time` is older than
  5 minutes ("Sign in again to confirm this change").
- `401` — the ID token is valid Firebase, but belongs to a different
  account than the caller's session ("Incorrect sign-in" — deliberately
  the same shape as a wrong password, so probing this endpoint can't
  reveal which provider account maps to which internal user).

## Non-obvious decisions

- **5-minute freshness window.** A Firebase ID token stays valid for an
  hour, so its own expiry isn't enough to prove "just re-signed in." The
  `auth_time` claim is when the sign-in actually happened, and 5 minutes
  is long enough for the OS provider sheet and network round-trip but
  short enough that a token cached from an earlier session can't stand in
  for the fresh proof this action needs.
- **Same 401 shape for "wrong password" and "wrong linked account".**
  Otherwise the endpoint would double as an oracle for mapping social
  accounts to internal user ids.
- **`verifyOwnership` is the sensitive-action gate going forward.** Other
  endpoints that today take a password (delete account, change email) can
  move to it in a follow-up so social users get the same paths.

## Verified

TypeScript compilation clean. The behaviour follows from three checks
that are decidable from the code alone:

- Zod `.refine` at the schema level enforces "exactly one of password or
  idToken" — verified by inspection.
- `verifyFreshIdToken` compares `decoded.auth_time * 1000` against
  `Date.now() - MAX_TOKEN_AGE_SECONDS * 1000` — arithmetic-obvious.
- The `user_providers` lookup uses `(userId, provider, providerUid)` all
  three, so a token from a Firebase account not linked to this user
  cannot match and returns 401.

End-to-end proof against a live Firebase sign-in flow is left for staging.
