# Paid memberships: Stripe billing and Kinkané Plus gating

**Date:** 2026-08-02

## What changed

Kinkané Plus can now be bought. Readers subscribe through Stripe Checkout on the
web (monthly or annual), manage their own billing through Stripe's portal, and
the features listed as Plus in the membership strategy are now actually gated
behind it. Alongside that, every subscription state a user passes through is now
recorded with the dates it applied, so "what were they on in March" is a query
rather than a guess.

Three things this deliberately is **not**: it isn't in-app purchase (Apple/Google
take their own cut and their own rules — checkout is web-only), it doesn't put
the 90-day free trial into Stripe (it stays an in-app concept, no card required),
and it doesn't delete or hide anything when someone stops paying.

## Pricing

| | Standard | Founding Member (first 3 months after launch) |
|---|---|---|
| Monthly | $8.99 | $6.99 |
| Annual | $79.99 | $59.99 |

Founding Members keep their introductory price for their **first term only** —
one month, or one year — then roll onto standard pricing. That rollover is a
Stripe subscription schedule created when checkout completes, so Stripe performs
it; there is no job of ours that re-prices people, and nothing to go wrong a year
from now. Which price is in force is readable off the subscription row
(`price_id`), not inferred.

Amounts are never hardcoded in this repo. `GET /user/subscription/plans` reads
them from Stripe, so a price change in the dashboard doesn't need a deploy.

## What's gated

Free readers keep unlimited quizzes, "Why this book?" explanations, trending,
their Reader Profile, and all community reading.

Plus is required to **create**: community posts, comments, likes, bookshelf
saves, the personalised Explore page, and the preference-refresh loop that
teaches Kinkané your tastes.

The asymmetry is deliberate and worth stating plainly: **reads and deletes are
never gated.** A member who lapses keeps their bookshelf, their history and their
posts, can still see all of it, and can still take their own content down. They
just can't add more. Nothing is deleted or hidden on downgrade.

Gating is behind `GATING_ENABLED`, off by default, so it ships dark and can be
switched on — or reverted — without a deploy.

The paywall answers **402 Payment Required**, not 403, with
`{ code: 'PLUS_REQUIRED', upgradeUrl }`. The client has to tell "you need to
subscribe" apart from "this isn't yours" without parsing prose, and 402 is the
only status that says the first thing unambiguously.

## Tracking state over time

`user_subscriptions` still holds current state only. Two tables carry history:

- **`subscription_state_history`** — every state a user has been in, stored as
  validity intervals (`effective_from` / `effective_to`, null = current). A
  partial unique index enforces exactly one open interval per user, so a bug
  that opens a second one fails loudly instead of quietly making every
  historical query ambiguous. Migration 0030 backfills one interval per existing
  subscription dated from signup, so accounts that predate the table aren't
  invisible in it.
- **`subscription_events`** — the transitions, now with the money attached
  (`amount_cents`, `currency`, `stripe_invoice_id`, `stripe_event_id`).

They answer different questions on purpose: history is *what was true*, events
are *what happened*. Reporting wants the first; support wants the second.

Every write goes through one function, `subscriptionStateService.applyState`.
That's what keeps the current row and the open interval in step — anything that
wrote the subscription row directly would silently corrupt the timeline.

## The trial-expiry race (a live bug, fixed here)

The 90-day trial is flipped to expired in two places: lazily when `getMe` reads a
stale row, and by the hourly sweep. The cron re-checked `status = 'trialing'`
inside its `UPDATE`, so it was safe. `getMe` didn't — it read the row, decided in
JS, then updated by primary key. Two consequences:

1. Two concurrent `getMe` calls both wrote the flip and both logged an `expired`
   event. That was already happening, before any of this work.
2. Once Stripe exists, a webhook landing between that read and that write gets
   clobbered — the user pays, and their own next request downgrades them.

Both paths now call one shared `expireTrialIfDue`, whose `UPDATE` carries its
guards (`status = 'trialing' AND stripe_subscription_id IS NULL`) and drives
everything downstream off `.returning()`. A caller that loses the race writes
nothing and logs nothing. If the Stripe guard ever actually fires it logs a
warning, because a trialing row with billing attached means a webhook was lost —
which is what the reconciliation cron is there to repair.

`trial_ends_at` is deliberately **not** cleared when someone converts. It's a
historical fact, and nulling it would make the guard depend on data shape rather
than on an explicit predicate.

## Webhooks

`POST /api/v1/user/subscription/webhook`, mounted ahead of `express.json` with a
raw body parser — Stripe signs the exact bytes it sends. Unauthenticated by
design; the signature is the authentication.

Handled: `checkout.session.completed`, `customer.subscription.created/updated/
deleted/paused/resumed`, `invoice.paid`, `invoice.payment_failed`,
`charge.refunded`. Anything else is recorded and ignored, so enabling extra
events in the dashboard is harmless.

Three properties every handler holds:

- **Idempotent.** Every event id is claimed in `stripe_webhook_events` before its
  handler runs; a duplicate delivery loses that race and is skipped. Stripe
  delivers at-least-once.
- **Order-independent.** Handlers write the state the event describes rather than
  applying a delta, and events for a subscription the user has since replaced are
  detected and dropped.
- **Never guesses whose subscription it is.** Resolution is by stored customer
  id, then `metadata.userId`. If neither matches, it logs an error and stops —
  granting Plus to the wrong account is worse than not granting it.

The endpoint answers 200 as soon as the event is durably recorded. A handler
failure is stored on the event row rather than returned, because a non-2xx makes
Stripe retry for days and turns one bug into a retry storm.

`past_due` keeps Plus access. Stripe retries a failed charge over several days,
and the usual cause is an expired card — cutting someone off on the first failure
costs more in churn than the few days of access it saves.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/user/subscription` | current state for the paywall/account screen |
| GET | `/api/v1/user/subscription/history` | the user's own state timeline |
| GET | `/api/v1/user/subscription/plans` | live pricing from Stripe |
| POST | `/api/v1/user/subscription/checkout-session` | `{ plan }` → Checkout URL |
| POST | `/api/v1/user/subscription/portal-session` | → Billing Portal URL |
| POST | `/api/v1/user/subscription/upgrade` | **deprecated**, now delegates to checkout — removed 2026-08-07 |
| POST | `/api/v1/user/subscription/webhook` | Stripe only |

The client names a plan and nothing else — prices are resolved server-side, so a
crafted request can't choose what it pays. Return URLs are restricted to the
Kinkané origin; an open redirect at the end of checkout would land a user on an
attacker's page at the exact moment they're primed to trust it.

`/upgrade` was the pre-Stripe stub that returned `{ status: 'pending' }`. It
still returns that key, plus a real checkout URL, so an un-updated client doesn't
break. Remove it after the app ships a version that uses `/checkout-session`.
(Removed on 2026-08-07 — see `2026-08-07-remove-upgrade-endpoint.md`.)

## Emails

Subscription confirmed, payment failed, and cancellation, all through the
existing queue at priority 1 — billing mail is as critical as password mail,
since a payment failure nobody sees becomes a cancellation nobody chose. Renewal
receipts are left to Stripe rather than duplicated.

## Operations

- **Reconciliation cron**, daily at 03:15 UTC: re-reads every Stripe-backed
  subscription from Stripe and repairs drift. Webhooks are the primary path and
  they can be lost, arrive out of order, or hit a handler that threw — all
  silently. Without this, the detector for that is a support ticket.
- Stripe config is **optional** at boot. Without it the server starts normally
  and only the subscription routes answer 503. Local dev, CI and the existing
  deployment predate payments and shouldn't be broken by a missing key.

## Left out of scope

- **In-app purchase.** Web checkout only. If the app ever needs to sell inside
  iOS/Android, that's App Store Server Notifications and Google RTDN as a second
  billing source — the schema would need a `provider` column.
- **Admin surface** for comping or extending subscriptions. `subscription_events`
  already has `admin_user_id` for it; no endpoint yet.
- **Proration and plan-switch UI.** Handled by Stripe's portal.
- **Dunning emails beyond the first failure.** Stripe's Smart Retries send those.

## How it was verified

- `npx tsc --noEmit` clean; full Vitest suite passes (74 tests).
- New tests cover price resolution inside/outside the founding window, the
  half-configured-promotion fallback, price→plan mapping, and the trial-expiry
  guards — including the race case: when the conditional `UPDATE` matches no
  rows, no event and no history interval are written.
- **Not yet verified against live Stripe.** Nothing here has talked to the Stripe
  API — that needs test-mode keys, the four Prices created, and a run through
  `stripe listen --forward-to localhost:3000/api/v1/user/subscription/webhook`
  before this goes anywhere near production.

## Migration note

Migration 0030 uses `ALTER TYPE ... ADD VALUE`, which requires PostgreSQL 12 or
newer to run inside a transaction. The new enum values aren't used within the
migration itself, so it commits cleanly.
