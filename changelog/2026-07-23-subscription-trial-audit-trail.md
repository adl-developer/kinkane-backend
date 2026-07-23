# Track trial lifecycle and persist trial expiry instead of computing it on the fly

**Date:** 2026-07-23

## What changed

`user_subscriptions` previously had no record of anything happening to a
trial — `trial_ends_at` just held whatever the current value was, and a
trial "expiring" was purely a computed fallback (`getEffectiveTier()`)
applied at read time; the row itself never changed. That meant two things
were impossible to answer from the DB: "has this trial ever been extended,
by whom, from what value?" and "how many trials expired last week?"

This adds:

- `subscription_status` enum gains an `'expired'` value (alongside
  `active`/`trialing`/`cancelled`), and `user_subscriptions` gains
  `trial_expired_at` — the actual moment a trial was flipped, distinct from
  `trial_ends_at` (the scheduled deadline).
- A new append-only `subscription_events` table
  ([subscriptions.ts](../src/db/schema/subscriptions.ts)): one row per
  lifecycle event (`started`, `extended`, `expired`, `converted`,
  `cancelled`), with `previous_trial_ends_at`/`new_trial_ends_at` and an
  optional `admin_user_id` for admin-triggered events. This is the table
  that will answer "who extended this trial" once an admin-facing extend
  endpoint is built — it isn't part of this change, but the audit trail it
  would write into now exists.
- A `started` event is now recorded at both signup paths (email/password and
  social login) in `auth.service.ts`.
- `authService.getMe()` now does the expiry flip itself the first time it
  reads a lapsed trial (status/tier/`trial_expired_at` written, `expired`
  event logged), instead of only returning a computed value.
- A new hourly cron, `trial-expiry.cron.ts`, sweeps any trialing row whose
  `trial_ends_at` has passed and flips it the same way. This is the backstop
  for accounts that never call `getMe` — without it, a dormant user's trial
  would never actually resolve to `expired` in the DB, undercounting
  expirations in any future reporting.

## Non-obvious decisions

- **Two mechanisms, not one.** The read-time flip in `getMe` alone would
  never touch a dormant account's row, understating expirations. The cron
  alone would leave a lag between the real deadline and the DB reflecting
  it for anyone querying live. Doing both means whichever happens first
  wins; the cron's update is scoped to `status='trialing'` in its `WHERE`
  clause so a row already flipped by `getMe` (or a concurrent cron run in
  another worker) is simply skipped, not double-written or double-logged.
- **`trial_expired_at` is separate from `trial_ends_at`.** The former is
  "when we actually recorded this as expired"; the latter is "when it was
  scheduled to expire." They're usually close but not required to be equal
  (a dormant account swept an hour late, for instance).
- **`getEffectiveTier()` is kept, not removed** — it's now just a fallback
  for the brief window between `trial_ends_at` passing and one of the two
  write paths actually catching it, rather than the only source of truth.

## Out of scope

No admin endpoint to actually extend a trial yet — that was the original
ask this work supports, but building the endpoint itself is a separate
change. This only makes sure `subscription_events` and the `extended` event
type are ready for it.

## Verification

- `tsc --noEmit` passes.
- `npm run db:generate` produced
  [0023_absurd_toxin.sql](../drizzle/0023_absurd_toxin.sql) — reviewed by
  hand; adds the enum value, the `trial_expired_at` column, and the new
  table with its two FKs and index.
- Existing test suite (`vitest run`) passes unchanged.
