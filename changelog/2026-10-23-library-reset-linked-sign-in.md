# Clearing a shelf now checks the sign-in belongs to the shelf's owner

**Date:** 2026-10-23

## What changed

`POST /api/v1/user-books/reset` deletes everything on the caller's shelf. It is
confirmed with the password, or, for Google/Apple/Facebook accounts, a fresh
Firebase ID token.

The token check was its own inline copy, and it only asked two questions: is
the token valid, and was the sign-in in the last 5 minutes? It never asked
**whose** sign-in it was. So someone holding a stolen Kinkané session could
sign in with *their own* Google account, take that fresh token, and clear the
victim's shelf.

`resetLibrary` now calls `authService.verifyOwnership`, the same check that
change plan, group delete and account deletion use. As well as validity and
freshness, it requires the token's provider account (`sign_in_provider` +
`uid`) to be linked to the caller in `user_providers`. A token for any other
account gets `401 Incorrect sign-in`, the same as a wrong password.

The endpoint also had no rate limit, so the password check could be guessed
at freely with a stolen session. It now allows **10 attempts per hour per
user**, in its own bucket, matching account deletion.

## API shape

The request body is unchanged: exactly one of `{ password }` or `{ idToken }`.
Some error messages change to the shared ones:

| Case | Before | Now |
|---|---|---|
| Firebase rejects the token | `Invalid Firebase ID token` | `Invalid or expired sign-in token` |
| Token older than 5 minutes | `Re-authentication required — please sign in again before resetting your library` | `Sign in again to confirm this change` |
| Token for an unlinked account | *(accepted, shelf cleared)* | `401 Incorrect sign-in` |
| Password sent for a social account | `This account uses social login — provide a Firebase ID token instead of a password` | `This account uses social login and has no password` |
| Too many attempts | *(no limit)* | `429` |

Status codes are unchanged apart from the new 401 and 429. The app should
already be handling any 401 here by asking the user to sign in again.

## Decisions

- **Reuse, not patch.** The inline check could have had the linked-provider
  query added to it. Moving to `verifyOwnership` instead means there is one
  definition of "re-proved who they are" across all four destructive
  endpoints. A fifth copy can't drift the way this one did.
- **The "user not found" lookup is gone.** The caller comes from a valid
  access token. A user deleted mid-request now gets a 401 (no linked
  provider, or no password row) rather than a 404, and nothing is cleared
  either way.

## Verification

`src/__tests__/library-reset-reauth.test.ts`:

- fresh token, provider not linked to this user → 401 `Incorrect sign-in`, shelf untouched
- fresh token from a linked provider → shelf cleared, exclusions cache busted
- token from a sign-in 10 minutes ago → 401, shelf untouched
- password sent for a passwordless account → 400, shelf untouched

The first test fails against the old code, where the shelf gets cleared. The
full suite (106 files, 1608 tests) and `tsc --noEmit` pass.
