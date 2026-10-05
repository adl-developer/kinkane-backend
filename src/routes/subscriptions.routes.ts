import { Router, Request, Response } from 'express';
import express from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { wrap, wrapHttp } from '../lib/route-helpers';
import { checkoutLimiter } from '../middleware/rate-limit.middleware';
import { subscriptionsController } from '../controllers/subscriptions.controller';

const router = Router();

/**
 * GET /api/v1/user/subscription
 *
 * The authenticated user's current subscription — tier, status, plan, trial
 * countdown, renewal date and whether the Founding Member offer is still open.
 * The single source of truth for the client's paywall and account screen.
 *
 * Returns 200: { tier, status, plan, trialEndsAt, trialDaysLeft,
 *                currentPeriodEnd, cancelAtPeriodEnd, isFoundingMember,
 *                hasBillingAccount, foundingOfferActive, paymentsAvailable }
 * Errors: 401 unauthenticated | 404 no subscription row
 */
router.get('/', requireAuth, wrap(subscriptionsController.get));

/**
 * GET /api/v1/user/subscription/history
 *
 * The user's subscription state over time, newest first — each entry is a state
 * and the window it was in force for.
 *
 * Returns 200: { history: [{ tier, status, plan, isFoundingMember,
 *                            cancelAtPeriodEnd, reason, effectiveFrom, effectiveTo }] }
 * Errors: 401 unauthenticated
 */
router.get('/history', requireAuth, wrap(subscriptionsController.history));

/**
 * GET /api/v1/user/subscription/plans
 *
 * The purchasable plans with live pricing from Stripe, so the client never
 * hardcodes an amount. During the launch window the returned amounts are the
 * Founding Member prices, with `standardAmountCents` alongside for showing the
 * saving.
 *
 * Returns 200: { foundingOfferActive, foundingOfferEndsAt, plans: [...] }
 * Errors: 401 unauthenticated | 503 payments not configured
 */
router.get('/plans', requireAuth, wrapHttp(subscriptionsController.plans));

/**
 * POST /api/v1/user/subscription/checkout-session
 *
 * Creates a Stripe Checkout session and returns its URL for the client to open.
 * The client names a plan only — prices are resolved server-side, so a request
 * can't choose what it pays.
 *
 * Body: { plan: 'monthly'|'annual', successUrl?, cancelUrl? }
 *   successUrl/cancelUrl must be on the Kinkané origin.
 * Returns 200: { url, sessionId, plan, isFounding }
 * Errors: 400 validation | 401 unauthenticated | 409 already subscribed |
 *         429 rate limit | 503 payments not configured
 */
router.post(
  '/checkout-session',
  requireAuth,
  checkoutLimiter,
  wrapHttp(subscriptionsController.createCheckoutSession),
);

/**
 * POST /api/v1/user/subscription/cancel
 *
 * Cancels the subscription from inside the app — no Stripe-hosted page, no
 * webview. Sending someone out to a Stripe-branded site to stop paying is a
 * poor experience, and cancellation is a single flag rather than one of the
 * genuinely hard billing flows (proration, dunning, SCA) that stay in the
 * portal.
 *
 * Takes effect at the END of the paid period, never immediately: the user has
 * already paid for this term, and revoking it on click both destroys value they
 * bought and invites refund requests. They keep Plus until `accessEndsAt`.
 *
 * Idempotent — cancelling twice returns the same state rather than an error.
 *
 * Returns 200: { cancelAtPeriodEnd: true, accessEndsAt, tier, status }
 * Errors: 401 unauthenticated | 404 no subscription |
 *         409 NO_PAID_SUBSCRIPTION (trialing or free — the trial is ours, not
 *         Stripe's, so there is nothing to cancel) | 503 payments not configured
 */
router.post('/cancel', requireAuth, wrapHttp(subscriptionsController.cancel));

/**
 * POST /api/v1/user/subscription/change
 *
 * Switches plan (monthly/annual/free) for the end of the current period.
 * Confirmed with either the account password (password accounts) or a fresh
 * Firebase ID token from the same provider they signed in with (social
 * accounts, which have no password). Exactly one of `password` or `idToken`
 * is required. A social ID token counts as "fresh" only when its auth_time
 * is within 5 minutes — the client is expected to prompt a re-sign-in.
 *
 * `plan: 'free'` is the same underlying action as POST /cancel, so it also
 * requires a `reason` (and `reasonOther` when reason is 'other'). Every
 * cancellation flows through the reasons ledger regardless of which button
 * reached it.
 *
 * Body: { plan: 'monthly'|'annual'|'free', password? | idToken?,
 *         reason? (required if plan=free), reasonOther? }
 * Returns 200: { currentPlan, pendingPlan, effectiveAt, tier, status }
 * Errors: 400 validation | 401 unauthenticated | 401 incorrect password |
 *         401 expired sign-in token | 404 no subscription |
 *         409 NO_PAID_SUBSCRIPTION | 409 PENDING_CANCELLATION (reactivate first) |
 *         409 already on this plan | 503 payments not configured
 */
router.post(
  '/change',
  requireAuth,
  checkoutLimiter,
  wrapHttp(subscriptionsController.changePlan),
);

/**
 * POST /api/v1/user/subscription/reactivate
 *
 * Undoes a scheduled cancellation while the period is still running — the
 * request that always follows a cancel button. Without it, a user who cancelled
 * by accident can only return via a fresh checkout, which means a new billing
 * date and, during the launch window, losing their Founding Member price.
 *
 * Returns 200: { cancelAtPeriodEnd: false, accessEndsAt, tier, status }
 * Errors: 401 unauthenticated | 404 no subscription |
 *         409 NO_PAID_SUBSCRIPTION | 409 SUBSCRIPTION_ENDED (the period already
 *         elapsed and Stripe deleted it — start a new one) | 503 not configured
 */
router.post('/reactivate', requireAuth, wrapHttp(subscriptionsController.reactivate));

/**
 * POST /api/v1/user/subscription/apple/verify
 *
 * Called by the iOS app after an App Store purchase or restore. The server asks
 * Apple about the transaction, links the App Store subscription to this account
 * and switches Plus on. Call it before finishing the StoreKit transaction, so
 * StoreKit redelivers the purchase if this request never lands.
 *
 * Body: { transactionId }  (StoreKit's transaction id; any in the chain works)
 * Returns 200: the same body as GET /user/subscription, with provider 'apple'
 * Errors: 400 validation | 401 unauthenticated |
 *         404 APPLE_TRANSACTION_NOT_FOUND |
 *         409 APPLE_SUBSCRIPTION_IN_USE (linked to another Kinkané account) |
 *         409 APPLE_ACCOUNT_MISMATCH (bought while signed in as someone else) |
 *         409 APPLE_SUBSCRIPTION_INACTIVE (expired or refunded) |
 *         409 STRIPE_SUBSCRIPTION_ACTIVE (already paying on the web) |
 *         429 rate limit | 502 APPLE_IAP_UPSTREAM | 503 APPLE_IAP_UNAVAILABLE
 */
router.post(
  '/apple/verify',
  requireAuth,
  checkoutLimiter,
  wrapHttp(subscriptionsController.appleVerify),
);

export default router;

/**
 * The Stripe webhook, exported separately because it cannot live under the
 * normal API router: signature verification needs the unparsed request body,
 * so it has to be mounted ahead of express.json() in app.ts, with its own raw
 * body parser and no rate limiter (Stripe's delivery volume is not abuse).
 */
export const webhookRouter = Router();

/**
 * App Store Server Notifications V2 — renewals, cancellations, refunds and
 * failed payments for subscriptions bought in the iOS app. Mounted in app.ts
 * outside the API rate limiter, like the Stripe webhook. Plain JSON: nothing
 * in the body is trusted, so there is no signature to check against raw bytes.
 */
export const appleNotificationRouter = Router();

appleNotificationRouter.post('/', (req: Request, res: Response) => {
  subscriptionsController.appleNotification(req, res).catch((err: Error) => {
    res.status(500).json({ error: err.message });
  });
});

webhookRouter.post(
  '/',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req: Request, res: Response) => {
    subscriptionsController.webhook(req, res).catch((err: Error) => {
      // Never leaks past this point: an unhandled rejection here would mean
      // Stripe retries an event we've already recorded.
      res.status(500).json({ error: err.message });
    });
  },
);
