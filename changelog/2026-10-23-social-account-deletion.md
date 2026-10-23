# Let Google and Apple accounts delete themselves

**Date:** 2026-10-23

## What changed

`DELETE /api/v1/auth/account` only accepted `{ password }`. People who signed
up with Google or Apple never set a password, so every attempt came back
`400 This account uses social login and has no password`. They couldn't
delete their account from the app at all. App Store guideline 5.1.1(v)
requires in-app deletion for every account, so this was also a review risk.

The endpoint now takes **exactly one** of:

```json
{ "password": "..." }   // password accounts, unchanged
{ "idToken": "..." }    // Google/Apple accounts
```

`idToken` is a Firebase ID token. It must come from a sign-in in the **last
5 minutes** (`auth_time`), and its provider account must be **already linked
to the caller**. Sending neither or both is a 400 and never reaches the
service.

## How

There was no new verification code to write. `authService.verifyOwnership`
already does password-or-fresh-token checks for Change Plan
(`POST /subscriptions/change-plan`) and group delete. `deleteAccount` used to
call `verifyPassword` directly; it now calls `verifyOwnership`. The
controller schema follows the Change Plan one: both fields optional, plus an
exactly-one refine.

Everything after verification is the same as before. Stripe is cancelled
first, refresh tokens and the user row are deleted in one transaction, and
the goodbye email is queued.

## Decisions

- **Freshness window: 5 minutes, shared.** It's the same `MAX_TOKEN_AGE_SECONDS`
  that plan changes use. A Firebase ID token stays valid for an hour, so if
  we accepted the cached one the app already holds, this check would mean
  nothing. The client has to prompt a real re-sign-in.
- **The provider has to be linked to *this* user.** A valid token for some
  other Google account returns the same `401 Incorrect sign-in` as a wrong
  password, so the endpoint can't be used to find out which Google account
  belongs to which user.
- **Accounts with both a password and a linked provider can use either.**
  Same as Change Plan.
- **No email-link fallback.** An emailed confirmation link would also work for
  social accounts, but the app already runs the Google/Apple re-sign-in flow
  for plan changes, so reusing it is less work for the client.

## Client work needed

On the delete-account screen, if `providers` on `GET /auth/me` is non-empty,
offer "Confirm with Google/Apple". `/me` has no has-password flag, but an
account with a linked provider can confirm with its token whether or not it
also has a password, so this is always safe. Then re-run the provider
sign-in, get `currentUser.getIdToken(true)`, and send `{ idToken }`. If the
response is a 401, ask the user to sign in again and retry.

## Verification

`src/__tests__/social-account-deletion.test.ts`:

- fresh linked token → Stripe terminated, both deletes run, email queued
- token from a sign-in 10 minutes ago → 401; Stripe and DB untouched
- valid token, provider not linked to this user → 401 `Incorrect sign-in`; untouched
- token Firebase rejects → 401; untouched
- password sent for a passwordless account → 400; untouched
- body with neither / both credentials → 400 before the service is called
- `{ idToken }` body is passed through to the service

The full suite (105 files, 1604 tests) and `tsc --noEmit` both pass. Not
tested against real Firebase.
