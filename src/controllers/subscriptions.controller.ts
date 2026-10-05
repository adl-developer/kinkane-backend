import { Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { logger } from '../lib/logger';
import { config } from '../config';
import { isStripeConfigured, isFoundingWindowOpen } from '../lib/stripe';
import { subscriptionStateService } from '../services/subscriptions/state.service';
import { checkoutService } from '../services/subscriptions/checkout.service';
import { webhooksService } from '../services/subscriptions/webhooks.service';
import { authService } from '../services/auth.service';
import { appleSubscriptionsService } from '../services/subscriptions/apple.service';
import { appAccountTokenFor, assertAppleConfigured, isAppleConfigured } from '../lib/apple-store';
import type { UserSubscription } from '../db/schema';

const checkoutSchema = z.object({
  plan: z.enum(['monthly', 'annual']),
  // Optional overrides so the web app can return the user to the page they
  // started from. Restricted to our own origin — an open redirect here would
  // let a crafted link bounce a paying user to an attacker's page immediately
  // after checkout, which is exactly when they're primed to trust it.
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const cancelReasonSchema = z
  .object({
    reason: z.enum(['not_using', 'accidental', 'too_expensive', 'other']),
    reasonOther: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => data.reason !== 'other' || Boolean(data.reasonOther), {
    message: 'reasonOther is required when reason is "other"',
    path: ['reasonOther'],
  });

// A plan change is confirmed with either the account password (for password
// accounts) or a fresh Firebase ID token from the same social provider they
// signed in with (for accounts that never had one). Exactly one of the two
// is required — a request carrying neither, or both, is rejected up front.
//
// A plan change to 'free' is the same underlying action as POST /cancel, so
// the client also has to provide the same reason data in that case.
const changePlanSchema = z
  .object({
    plan: z.enum(['monthly', 'annual', 'free']),
    password: z.string().min(1).optional(),
    idToken: z.string().min(1).optional(),
    reason: z.enum(['not_using', 'accidental', 'too_expensive', 'other']).optional(),
    reasonOther: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => Boolean(data.password) !== Boolean(data.idToken), {
    message: 'Provide exactly one of password or idToken',
    path: ['password'],
  })
  .refine((data) => data.plan !== 'free' || Boolean(data.reason), {
    message: 'reason is required when plan is "free"',
    path: ['reason'],
  })
  .refine((data) => data.reason !== 'other' || Boolean(data.reasonOther), {
    message: 'reasonOther is required when reason is "other"',
    path: ['reasonOther'],
  })
  .refine((data) => data.plan === 'free' || (!data.reason && !data.reasonOther), {
    message: 'reason/reasonOther only apply when plan is "free"',
    path: ['reason'],
  });

// StoreKit transaction ids are decimal strings. Anything else is a client bug,
// and refusing it here keeps junk out of the App Store API path.
const appleVerifySchema = z.object({
  transactionId: z.string().regex(/^\d{1,32}$/, 'transactionId must be an App Store transaction id'),
});

const appleNotificationSchema = z.object({
  signedPayload: z.string().min(1).max(100_000),
});

/**
 * The subscription as the client sees it — the body of GET /user/subscription
 * and of the Apple verify response, so the app updates its paywall from either
 * without a second call.
 */
function serializeSubscription(userId: number, sub: UserSubscription) {
  let trialDaysLeft: number | null = null;
  if (sub.status === 'trialing' && sub.trialEndsAt) {
    const msLeft = sub.trialEndsAt.getTime() - Date.now();
    trialDaysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  }

  return {
    tier: sub.tier,
    status: sub.status,
    plan: sub.plan,
    // 'stripe' | 'apple' | null. Decides which cancel/manage UI the client
    // shows: only Apple can change an App Store subscription.
    provider: sub.billingProvider,
    trialEndsAt: sub.trialEndsAt,
    trialDaysLeft,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    pendingPlan: sub.pendingPlan,
    isFoundingMember: sub.isFoundingMember,
    hasBillingAccount: Boolean(sub.stripeCustomerId),
    foundingOfferActive: isFoundingWindowOpen(),
    paymentsAvailable: isStripeConfigured(),
    appleIapAvailable: isAppleConfigured(),
    // Pass as `appAccountToken` when starting an App Store purchase.
    appleAppAccountToken: appAccountTokenFor(userId),
  };
}

function assertSameOrigin(url: string | undefined, label: string): string | undefined {
  if (!url) return undefined;
  const allowed = new URL(config.appUrl).origin;
  if (new URL(url).origin !== allowed) {
    throw Object.assign(new Error(`${label} must be a Kinkané URL`), { statusCode: 400 });
  }
  return url;
}

export const subscriptionsController = {
  /**
   * GET /api/v1/user/subscription
   * Everything the client needs to render the paywall and the account screen.
   */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const sub = await subscriptionStateService.getCurrent(req.user.id);

    if (!sub) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }

    res.status(200).json(serializeSubscription(req.user.id, sub));
  },

  /**
   * GET /api/v1/user/subscription/history
   * The user's own subscription timeline — every state, and when it applied.
   */
  async history(req: AuthenticatedRequest, res: Response): Promise<void> {
    const history = await subscriptionStateService.history(req.user.id);
    res.status(200).json({
      history: history.map((row) => ({
        tier: row.tier,
        status: row.status,
        plan: row.plan,
        isFoundingMember: row.isFoundingMember,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        pendingPlan: row.pendingPlan,
        reason: row.reason,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
      })),
    });
  },

  /** GET /api/v1/user/subscription/plans */
  async plans(_req: AuthenticatedRequest, res: Response): Promise<void> {
    res.status(200).json(await checkoutService.listPlans());
  },

  /** POST /api/v1/user/subscription/checkout-session */
  async createCheckoutSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await checkoutService.createCheckoutSession(
      req.user.id,
      parsed.data.plan,
      assertSameOrigin(parsed.data.successUrl, 'successUrl'),
      assertSameOrigin(parsed.data.cancelUrl, 'cancelUrl'),
    );

    res.status(200).json(result);
  },

  /**
   * POST /api/v1/user/subscription/cancel
   *
   * Cancels in-app, without sending the user to Stripe. Takes effect at the end
   * of the period they have already paid for.
   */
  async cancel(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = cancelReasonSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await checkoutService.cancel(
      req.user.id,
      parsed.data.reason,
      parsed.data.reasonOther,
    );
    res.status(200).json(result);
  },

  /**
   * POST /api/v1/user/subscription/change
   *
   * The "Change Plan" flow — switches monthly/annual/free for the end of the
   * current period, confirmed with the account password. Password verification
   * happens here, before checkoutService ever touches Stripe, so a wrong
   * password never triggers a schedule call.
   *
   * `plan: 'free'` reaches the same code path as POST /cancel, so it also
   * requires a reason (and reasonOther for 'other'). Every cancellation goes
   * through the reason picker regardless of which screen it was reached from
   * — otherwise the reasons ledger would be missing every user who picked
   * Free Plan out of the Change Plan menu.
   */
  async changePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }

    await authService.verifyOwnership(req.user.id, {
      password: parsed.data.password,
      idToken: parsed.data.idToken,
    });
    const result = await checkoutService.changePlan(
      req.user.id,
      parsed.data.plan,
      parsed.data.reason,
      parsed.data.reasonOther,
    );
    res.status(200).json(result);
  },

  /**
   * POST /api/v1/user/subscription/reactivate
   *
   * Undoes a scheduled cancellation while the period is still running.
   */
  async reactivate(req: AuthenticatedRequest, res: Response): Promise<void> {
    const result = await checkoutService.reactivate(req.user.id);
    res.status(200).json(result);
  },

  /**
   * POST /api/v1/user/subscription/apple/verify
   *
   * The iOS app has completed or restored an App Store purchase. The
   * transaction id is only a pointer: what was bought is read from Apple.
   */
  async appleVerify(req: AuthenticatedRequest, res: Response): Promise<void> {
    assertAppleConfigured();
    const parsed = appleVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const sub = await appleSubscriptionsService.verifyPurchase(req.user.id, parsed.data.transactionId);
    res.status(200).json(serializeSubscription(req.user.id, sub));
  },

  /**
   * POST /api/v1/user/subscription/apple/notifications
   *
   * App Store Server Notifications V2. Unauthenticated by design, like the
   * Stripe webhook — but where Stripe's signature is the authentication, here
   * nothing in the body is trusted at all: it only names a transaction, which
   * is then re-read from Apple with our own credentials.
   *
   * Answers 200 once the notification is recorded, failures included (they're
   * stored on the row and reconciliation repairs them). Apple retries any
   * non-2xx, so only a body that isn't a notification at all gets a 400.
   */
  async appleNotification(req: Request, res: Response): Promise<void> {
    const parsed = appleNotificationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing signedPayload' });
      return;
    }
    if (!isAppleConfigured()) {
      res.status(503).json({ error: 'App Store purchases are not configured' });
      return;
    }

    try {
      const { duplicate } = await appleSubscriptionsService.handleNotification(parsed.data.signedPayload);
      res.status(200).json({ received: true, ...(duplicate && { duplicate: true }) });
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      if (e.statusCode === 400) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw err;
    }
  },

  /**
   * POST /api/v1/user/subscription/webhook
   *
   * Unauthenticated by design — the Stripe signature over the raw body is the
   * authentication, and `req.body` here is a Buffer, not parsed JSON.
   *
   * Answers 200 as soon as the event is durably recorded. Stripe retries any
   * non-2xx for days, so a handler bug must not turn into a retry storm: a
   * failure is stored on the event row and left for reconciliation instead.
   */
  async webhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['stripe-signature'];

    if (typeof signature !== 'string') {
      res.status(400).json({ error: 'Missing Stripe signature header' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = webhooksService.constructEvent(req.body as Buffer, signature);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      logger.warn('Rejected Stripe webhook', { error: e.message });
      res.status(e.statusCode ?? 400).json({ error: e.message });
      return;
    }

    const claimed = await webhooksService.claimEvent(event);
    if (!claimed) {
      // Duplicate delivery — already recorded, and possibly already applied.
      logger.info('Skipping duplicate Stripe webhook delivery', {
        eventId: event.id,
        type: event.type,
      });
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    try {
      await webhooksService.handleEvent(event);
      await webhooksService.markProcessed(event.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Stripe webhook handler failed', {
        eventId: event.id,
        type: event.type,
        error: message,
      });
      await webhooksService.markProcessed(event.id, message);
    }

    res.status(200).json({ received: true });
  },
};
