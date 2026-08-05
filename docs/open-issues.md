# Open Issues — QA Review (2026-08-04)

Found during the Stripe subscriptions + push notifications code review.
To be logged as GitHub issues when `gh auth login` is available.

---

## [CRITICAL] `/plans` endpoint calls Stripe 4× per request with no cache

**File:** `src/services/subscriptions/checkout.service.ts:188`

`listPlans()` calls `stripe().prices.retrieve()` up to 4 times per request (once per plan, with a potential second call for the standard price during the founding window). There is no cache. Under load, concurrent requests will hit Stripe's rate limit and stall. Fix: cache the result in Redis for ~5 minutes, bust on deploy or price change.

**Labels:** `bug`, `performance`, `payments`

---

## [HIGH] Reconciliation cron loads all subscribers into memory then makes sequential Stripe calls

**File:** `src/jobs/subscription-reconciliation.cron.ts:32`

The cron fetches every row with a Stripe subscription ID in one query, then calls `stripe().subscriptions.retrieve()` sequentially for each. At scale this will exhaust memory and hit Stripe rate limits. Fix: paginate the DB fetch and add a concurrency cap (e.g. `p-limit` with `concurrency: 5`).

**Labels:** `bug`, `performance`, `payments`

---

## [HIGH] `invoice.payment_failed` webhook inserts duplicate event rows on replay

**File:** `src/services/subscriptions/webhooks.service.ts:565`

`onInvoicePaymentFailed` inserts a `subscription_events` row unconditionally — even when `applyState` returns null (indicating a duplicate delivery). The `stripeEventId` column on `subscription_events` has no unique constraint, so replayed events write duplicate rows. Fix: guard the insert on `if (updated)`, or add a unique index on `(stripeEventId, event)`.

**Labels:** `bug`, `payments`

---

## [MEDIUM] `/plans` route has no rate limiter despite making live Stripe API calls

**File:** `src/routes/subscriptions.routes.ts:47`

`GET /plans` is authenticated but unthrottled. An authenticated user can hammer it to burn through Stripe API quota. Fix: apply `checkoutLimiter` (or a dedicated read limiter) to this route.

**Labels:** `security`, `payments`

---

## [MEDIUM] `checkoutLimiter` crashes with TypeError if `req.user` is undefined

**File:** `src/middleware/rate-limit.middleware.ts:72`

```ts
keyGenerator: (req: Request) => String((req as AuthenticatedRequest).user.id),
```

If `req.user` is ever absent (wrong middleware order, edge case in `requireAuth`), this throws inside `express-rate-limit`'s internals and produces an unhandled 500. Fix: use `req.user?.id ?? req.ip` as the key.

**Labels:** `bug`, `security`

---

## [LOW] `mapStatus` logic is duplicated between webhook handler and reconciliation cron

**File:** `src/jobs/subscription-reconciliation.cron.ts:43` and `src/services/subscriptions/webhooks.service.ts`

Both files implement the same Stripe status → internal status mapping independently. If a new Stripe status is added (e.g. `paused`), it needs updating in two places. Fix: extract `mapStatus` to `src/lib/stripe.ts` and import it in both.

**Labels:** `refactor`, `payments`
