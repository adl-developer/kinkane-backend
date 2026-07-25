# Let people sign up without finishing onboarding first

**Date:** 2026-07-25

## What changed

`guestSessionId` is now optional on both signup paths instead of required:

- `POST /api/v1/auth/signup` ([auth.controller.ts](../src/controllers/auth.controller.ts)) —
  schema no longer requires a UUID for `guestSessionId`.
- Social login / registration
  ([auth.service.ts](../src/services/auth.service.ts)) — the branch that
  previously threw a `400` ("guestSessionId is required when creating a new
  account via social login") for a brand-new social user with no
  `guestSessionId` no longer does; the account is created either way.

In both paths, `migrateGuestSession(...)` (which carries onboarding
preferences, chosen books, and interaction signals onto the new account) now
only runs `if (guestSessionId)` — skipped entirely when it's absent, rather
than being called with an empty/undefined id.

Route docs in [auth.routes.ts](../src/routes/auth.routes.ts) updated to match:
`guestSessionId` is documented as optional on both endpoints, and the
signup docstring no longer states onboarding is a mandatory prerequisite.

## Why

Previously the API required every new account to have gone through the
onboarding quiz first. This relaxes that: a user can now create an account
directly, and only gets their onboarding data migrated in if they actually
have a guest session to attach.

## What's explicitly out of scope

- No change to what happens for users who *do* complete onboarding first —
  the migration behavior for a present `guestSessionId` is unchanged.
- No backfill or handling for accounts created without onboarding data beyond
  what already happens for any user with no `userPreferences` row (existing
  code paths already handle that case elsewhere, e.g. `personalized()`
  returning an empty feed).

## Testing done

- `tsc --noEmit` clean.
- `npm test` — existing 14 tests pass unchanged.
- No new test coverage added for the optional-vs-present `guestSessionId`
  branches in this pass.
