import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users, userSubscriptions } from '../../db/schema';
import type { SubscriptionPlan } from '../../db/schema';
import { config } from '../../config';
import { stripe, assertStripeConfigured, resolvePrice, isFoundingWindowOpen } from '../../lib/stripe';
import { logger } from '../../lib/logger';
import { subscriptionStateService } from './state.service';

/**
 * Creating Stripe Checkout and Billing Portal sessions.
 *
 * Cancellation, card updates and plan switches are deliberately *not*
 * implemented here — they go through Stripe's hosted Billing Portal. Rebuilding
 * them would mean reimplementing proration, dunning and SCA, and every one of
 * those flows already has to be handled on the webhook side regardless.
 */

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
  plan: SubscriptionPlan;
  isFounding: boolean;
}

export const checkoutService = {
  /**
   * Finds or creates this user's Stripe Customer and caches the id on their
   * subscription row.
   *
   * Reusing one customer per user is what keeps their billing history, saved
   * cards and portal access in one place — and it's what lets webhooks resolve
   * an event back to a user by customer id alone.
   */
  async ensureStripeCustomer(userId: number): Promise<string> {
    const sub = await subscriptionStateService.get(userId);
    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }
    if (sub.stripeCustomerId) return sub.stripeCustomerId;

    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    const customer = await stripe().customers.create({
      email: user.email,
      name: user.name,
      // The link back to us. Every webhook handler prefers this over guessing.
      metadata: { userId: String(userId) },
    });

    // Written directly rather than through applyState: attaching a customer id
    // is not a subscription state change — nothing about what they're entitled
    // to has moved, and it shouldn't open a new history interval.
    await db
      .update(userSubscriptions)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(userSubscriptions.userId, userId));

    logger.info('Created Stripe customer', { userId, stripeCustomerId: customer.id });
    return customer.id;
  },

  /**
   * Creates a Checkout Session for Kinkané Plus.
   *
   * The client names a plan and nothing else. Prices are resolved server-side
   * (see resolvePrice) so a crafted request can't subscribe at a price of its
   * own choosing.
   *
   * During the launch window the session is created against the Founding
   * Member price. The rollover to standard pricing after the first term is set
   * up separately, in the checkout.session.completed handler — a Stripe
   * subscription schedule can only be attached to a subscription that already
   * exists, and at this point it doesn't. See attachFoundingSchedule in
   * webhooks.service.ts.
   */
  async createCheckoutSession(
    userId: number,
    plan: SubscriptionPlan,
    successUrl?: string,
    cancelUrl?: string,
  ): Promise<CheckoutSessionResult> {
    assertStripeConfigured();

    const sub = await subscriptionStateService.getCurrent(userId);
    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    // Already paying — send them to the portal to change plans instead, so we
    // never create a second subscription for the same person.
    if (sub.stripeSubscriptionId && (sub.status === 'active' || sub.status === 'past_due')) {
      throw Object.assign(new Error('You already have an active Kinkané Plus subscription'), {
        statusCode: 409,
      });
    }

    const customerId = await this.ensureStripeCustomer(userId);
    const { priceId, standardPriceId, isFounding } = resolvePrice(plan);

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Both of these carry the user id back to us. client_reference_id is the
      // one that survives on the session; the metadata copy lands on the
      // subscription too, which is what later webhooks see.
      client_reference_id: String(userId),
      metadata: { userId: String(userId), plan },
      subscription_data: {
        metadata: { userId: String(userId), plan, isFounding: String(isFounding) },
      },
      success_url: successUrl ?? config.stripe.checkoutSuccessUrl,
      cancel_url: cancelUrl ?? config.stripe.checkoutCancelUrl,
      allow_promotion_codes: true,
      // Stripe collects and remits the VAT/sales tax where it applies. Without
      // this a UK-based book service selling into the EU is under-collecting.
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto' },
    });

    if (!session.url) {
      throw Object.assign(new Error('Stripe did not return a checkout URL'), { statusCode: 502 });
    }

    logger.info('Created Stripe checkout session', {
      userId,
      plan,
      isFounding,
      priceId,
      standardPriceId,
      sessionId: session.id,
    });

    return { url: session.url, sessionId: session.id, plan, isFounding };
  },

  /**
   * Billing Portal session — cancel, change card, switch plan, download
   * invoices. Everything that happens in there comes back to us as a webhook.
   */
  async createPortalSession(userId: number, returnUrl?: string): Promise<{ url: string }> {
    assertStripeConfigured();

    const sub = await subscriptionStateService.get(userId);
    if (!sub?.stripeCustomerId) {
      throw Object.assign(new Error('No billing account found for this user'), { statusCode: 404 });
    }

    const session = await stripe().billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: returnUrl ?? config.stripe.portalReturnUrl,
    });

    return { url: session.url };
  },

  /**
   * The plans to show on the paywall, priced from Stripe rather than from
   * anything hardcoded here — the amounts live in exactly one place, and a
   * price change in the dashboard doesn't need a deploy.
   */
  async listPlans(): Promise<{
    foundingOfferActive: boolean;
    foundingOfferEndsAt: Date | null;
    plans: Array<{
      plan: SubscriptionPlan;
      priceId: string;
      amountCents: number | null;
      currency: string | null;
      interval: string | null;
      isFounding: boolean;
      standardAmountCents: number | null;
    }>;
  }> {
    assertStripeConfigured();

    const founding = isFoundingWindowOpen();
    const plans = await Promise.all(
      (['monthly', 'annual'] as const).map(async (plan) => {
        const { priceId, standardPriceId, isFounding } = resolvePrice(plan);
        const price = await stripe().prices.retrieve(priceId);
        // Only worth a second API call when the two differ.
        const standard =
          priceId === standardPriceId ? price : await stripe().prices.retrieve(standardPriceId);

        return {
          plan,
          priceId,
          amountCents: price.unit_amount,
          currency: price.currency,
          interval: price.recurring?.interval ?? null,
          isFounding,
          standardAmountCents: standard.unit_amount,
        };
      }),
    );

    return {
      foundingOfferActive: founding,
      foundingOfferEndsAt: config.stripe.foundingOfferEndsAt ?? null,
      plans,
    };
  },
};
