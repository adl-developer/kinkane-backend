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

const checkoutSchema = z.object({
  plan: z.enum(['monthly', 'annual']),
  // Optional overrides so the web app can return the user to the page they
  // started from. Restricted to our own origin — an open redirect here would
  // let a crafted link bounce a paying user to an attacker's page immediately
  // after checkout, which is exactly when they're primed to trust it.
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const changePlanSchema = z.object({
  plan: z.enum(['monthly', 'annual', 'free']),
  password: z.string().min(1, 'Password is required'),
});

const cancelSchema = z
  .object({
    reason: z.enum(['not_using', 'accidental', 'too_expensive', 'other']),
    reasonOther: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => data.reason !== 'other' || Boolean(data.reasonOther), {
    message: 'reasonOther is required when reason is "other"',
    path: ['reasonOther'],
  });

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

    let trialDaysLeft: number | null = null;
    if (sub.status === 'trialing' && sub.trialEndsAt) {
      const msLeft = sub.trialEndsAt.getTime() - Date.now();
      trialDaysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
    }

    res.status(200).json({
      tier: sub.tier,
      status: sub.status,
      plan: sub.plan,
      trialEndsAt: sub.trialEndsAt,
      trialDaysLeft,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      pendingPlan: sub.pendingPlan,
      isFoundingMember: sub.isFoundingMember,
      hasBillingAccount: Boolean(sub.stripeCustomerId),
      foundingOfferActive: isFoundingWindowOpen(),
      paymentsAvailable: isStripeConfigured(),
    });
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
    const parsed = cancelSchema.safeParse(req.body);
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
   * current period, confirmed with the account password rather than a reason
   * (that's the Cancel Subscription flow's job). Password verification
   * happens here, before checkoutService ever touches Stripe, so a wrong
   * password never triggers a schedule call.
   */
  async changePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = changePlanSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
      return;
    }

    await authService.verifyPassword(req.user.id, parsed.data.password);
    const result = await checkoutService.changePlan(req.user.id, parsed.data.plan);
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
