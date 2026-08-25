# Deleting an account now stops billing

**Date:** 2026-08-11

## What was broken

Deleting an account never told Stripe. The user row was deleted, the cascade took
`user_subscriptions` with it, and the Stripe subscription carried on charging the
card — indefinitely, with nothing left in our database tying that subscription
back to anyone.

Every webhook that arrived afterwards failed to resolve a user and was logged and
dropped, so the only signal was the customer's bank statement.

## What changed

`auth.service.deleteAccount` now calls
`checkoutService.terminateForAccountDeletion(userId)` before the delete
transaction, which cancels the Stripe subscription **immediately**.

Immediately, not at period end — the opposite of the user-facing cancel path, and
deliberately so. There is no one left to preserve access for, and a
cancel-at-period-end subscription would bill a deleted account for a term nobody
can use.

The order matters: this has to run before the delete, because after it the
subscription id is gone.

## Non-obvious decisions

**It never throws, and deletion proceeds even when Stripe fails.** Account
deletion is a right the user is exercising; Stripe being unreachable is our
problem, not a reason to refuse it. The alternative — failing the request — means
a Stripe outage blocks people from leaving, which is worse than the alternative
failure mode and likely worse legally.

The cost is real and worth stating plainly: if the cancel call fails, that user
keeps being billed and the record linking the subscription to them is about to be
deleted. The error log is therefore the *only* remaining trace, so it logs at
error level with the user id, subscription id and customer id — everything needed
to find and cancel it by hand. This is the weakest point of the fix. A durable
"orphaned subscription" record that survives the delete would close it properly;
that needs a table and is deliberately out of scope here.

**The Stripe Customer is kept, not deleted.** Deleting a Customer also cancels
its subscriptions and would be a tidier single call, but it takes the invoice and
payment history with it — which the business still needs for accounting and tax
long after the user is gone.

**Schedule-managed subscriptions are released first**, the same as the ordinary
cancel path, since a Founding Member's subscription rejects cancellation set
directly on it. See `2026-08-11-founding-member-cancellation.md`.

**Already-ended subscriptions are skipped** rather than cancelled again, because
Stripe rejects a second cancellation.

## How it was verified

Five cases added to `src/__tests__/subscription-cancel.test.ts`: that it cancels
immediately rather than at period end, that it releases a founding schedule first
and in the right order, that a Stripe failure resolves `false` instead of
throwing, and that it no-ops for a user who never paid or whose subscription
already ended.

19 passing in that file, `tsc --noEmit` clean, full suite 230 passing. The three
failures in `subscription-pricing.test.ts` are pre-existing and unrelated — that
file spreads the real `.env` into its fixtures.
