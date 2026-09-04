# "Active customer" now means seen, not spent

**Date:** 2026-09-04

## What changed

In the admin console, a customer counts as **active** if they have been seen in
the last 12 months. Previously it meant they had *paid for something* in the
last 12 months.

This affects two places, and both moved together:

- the `active` flag on each row of `GET /admin/console/customers`, and the
  active/inactive cards above that table
- the "active customers" card on the Overview dashboard

The per-customer money columns — `orders`, `totalSpentMinor`, `lastOrderAt` —
are untouched and still count paid orders only. The revenue question is still
answerable, it just is not what the word "active" answers any more.

## Why

The console was showing every single customer as inactive. That turned out not
to be a bug in the flag: the rule was "has a paid order in the last 365 days",
and in the environment being looked at effectively nothing satisfied it. The
rule was working exactly as written and was still telling the operator nothing
useful.

The underlying problem is that "active" was measuring the wrong thing. A reader
who opens the app every week and has not yet bought a book is a live account by
any reasonable reading, and the old rule filed them alongside the genuinely
abandoned ones.

## The part that needed new data

Nothing in the schema could answer "when was this user last around". `users` had
no equivalent of the `admins` table's `last_login_at`, and the obvious stand-in
does not work: `refresh_tokens.created_at` is written on sign-in, but those rows
carry a 30-day TTL and are deleted on logout, rotation, password change and
blacklist. A user last seen six months ago has no rows at all, which is
indistinguishable from one who has never signed in. It cannot answer a one-year
question.

So `users.last_sign_in_at` is new (migration `0057_user_last_sign_in`), with an
index because the Customers list and the Overview card both filter on it on
every load.

## "Seen", deliberately, rather than "signed in"

The timestamp moves on **any authenticated request**, not only on password or
social login. With a 30-day refresh TTL and silent token rotation, a daily
mobile user can go a year without ever re-entering a credential — so keying this
on sign-in events would have filed the most engaged users as dormant, which is
the same class of mistake the change set out to fix.

Writing on every request would put a database write on the hot path of every
screen in the app, so `touchLastSignIn` throttles to one write per user per day.
The throttle is enforced twice: a process-local map so the common case issues no
query at all, and a `WHERE last_sign_in_at < now() - 1 day` clause that is the
actual authority (several instances each waking once a day is correct, just
marginally wasteful). It is fire-and-forget and never rejects — failing a
customer's request because an activity timestamp could not be written would be a
bad trade. On a failed write the local guard is cleared so the next request
retries rather than going quiet for a full day.

`issueTokenPair` — the single funnel for password, social, signup and refresh —
also records a sighting, so an account returning after a year of dormancy is
marked the moment it signs in rather than on whatever request happens next. It
goes through the same throttled, fire-and-forget call, deliberately:

- **Throttled**, because that funnel serves *refresh rotation* as much as real
  sign-ins. With a 15-minute access token an active client comes back through it
  roughly every 15 minutes, so an unconditional write there would mean ~96
  updates per user per day — the throttle defeated on the busiest auth path in
  the system.
- **Fire-and-forget**, because nothing about issuing a session depends on it. An
  earlier version awaited it alongside the refresh-token insert, which meant a
  transient database error turned a valid login into a 500 — with the refresh
  token row already committed, leaving the caller holding an orphan.

## The backfill, and why it is a fiction

Existing accounts were backfilled to their `created_at`.

There is no true value to recover — sign-ins were never recorded before this
change. The honest-looking alternative, leaving the column null and treating
null as inactive, reproduces the exact symptom this work started from: every
customer reads inactive, for a year, because the column is empty rather than
because anybody is dormant.

Seeding from signup date means recent signups read active, genuinely dormant old
accounts read inactive, and the fiction decays out of the data on its own as
real activity overwrites it. The migration does this in stages rather than as a
single `ADD COLUMN ... DEFAULT now() NOT NULL` (which is what `drizzle-kit`
generates for this schema change) — that one-liner would stamp every existing
account as seen *today* and the console would read "100% active" on first load.

## Decisions worth recording

- **Both surfaces changed together.** The Overview card and the Customers list
  render the same word from two different queries; they still share
  `ACTIVE_CUSTOMER_WINDOW_DAYS`. Changing only one would have left the dashboard
  disagreeing with the table about the same customers. Expect the Overview
  number to jump, because engagement is far more common than purchase.
- **The column is `NOT NULL`.** The backfill covers old rows and the default
  covers new ones, so "never seen" is not a state any row can be in and nothing
  downstream has to handle null.
- **The index is pre-built concurrently.** `idx_users_last_sign_in_at` is
  registered in `src/db/build-concurrent-indexes.ts`, which runs ahead of
  migrations, so from the second deploy onward the migration's `IF NOT EXISTS`
  finds it present and never takes the lock. That file gained a `column` guard
  for this: it runs *before* the migration that adds the column, so on the first
  deploy there is nothing to index yet and it now says so rather than throwing
  into the non-fatal handler. On that one deploy the migration builds the index
  itself, under a `SHARE` lock — the writers it can stall are sign-ins, which is
  worth knowing before choosing when to run it.
- **The throttle map evicts, it does not clear.** Overflow first drops entries
  older than the throttle window (they suppress nothing, so it is lossless) and
  only then sheds live guards, oldest first. Clearing the whole map was cheaper
  to write but discarded ~50k live guards at once, so the entire active
  population re-issued a redundant `UPDATE` on its next request. A working set
  genuinely larger than the cap will still thrash — that is a capacity question,
  not an eviction-policy one.

## Out of scope

- No "last seen" column in the console UI yet — `lastSignInAt` is returned by
  the API and documented, but the table still shows `lastOrderAt`.
- No separate revenue-active metric. If the operator later wants "paid in the
  last 12 months" back as its own figure, it is a second count, not a change to
  this one.
- The throttle map is process-local and is not shared across instances. A shared
  cache would be real infrastructure to save one write per user per day.

## Testing done

`src/__tests__/customer-activity.test.ts` (14 cases) covers the throttle
directly — first write happens, repeat calls inside the window do not write, a
new write happens after a day, throttling is per-account, a failed write clears
the guard so the next request retries, and the function never rejects into its
caller. Overflow eviction is pinned by a case that fills the map with 40k stale
and 10k live guards and asserts the live ones survive; it was checked against the
old clear-everything policy and fails there with 10,001 redundant writes, so it
is a real regression test rather than one that merely passes.

It also pins the properties the review turned up: `issueTokenPair` must use the
throttled call and must not await it, and the Customers list and Overview card
must key off the same column while the money columns still count paid orders
only.

Full suite: 684 passing. Four failures in `subscription-pricing` and
`referral-copy` predate this change and are unrelated (both are Stripe/referral
environment configuration); they fail identically on a clean tree.

**Not yet run against a database.** The migration has not been applied
anywhere — the configured `DATABASE_URL` points at the production instance, and
the backfill should be run deliberately rather than as a side effect. The
generated snapshot's end state matches what the staged SQL produces.
