import type Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users, userSubscriptions, subscriptionEvents } from '../../db/schema';
import type { SubscriptionPlan } from '../../db/schema';
import { config } from '../../config';
import {
  stripe,
  assertStripeConfigured,
  isStripeConfigured,
  resolvePrice,
  isFoundingWindowOpen,
} from '../../lib/stripe';
import { logger } from '../../lib/logger';
import { subscriptionStateService } from './state.service';
import { entitlementsService } from './entitlements.service';
import { schedulesService } from './schedules.service';
import { paymentsService } from '../payments.service';

/**
 * Creating Stripe Checkout sessions, plus in-app plan changes and
 * cancellation — cancel, change plan, and reactivate are all handled here
 * rather than via the Stripe-hosted Billing Portal, since sending someone out
 * to a Stripe-branded web page for routine billing actions is a bad
 * experience in a native app. Card updates and invoice history remain out of
 * scope: rebuilding those means reimplementing proration, dunning and SCA.
 */

/** What the client needs to re-render the account screen after cancel/resume. */
export interface CancellationResult {
  cancelAtPeriodEnd: boolean;
  /** When Plus actually stops. Null only if Stripe has no period on record. */
  accessEndsAt: Date | null;
  tier: string;
  status: string;
}

/** The reasons offered on the Cancel Subscription screen. */
export type CancelReason = 'not_using' | 'accidental' | 'too_expensive' | 'other';

const CANCEL_REASON_LABELS: Record<Exclude<CancelReason, 'other'>, string> = {
  not_using: "I don't use Kinkané enough",
  accidental: 'I subscribed by accident',
  too_expensive: 'Too expensive',
};

/** What the client needs to render "Manage your plan" after a Change Plan request. */
export interface PlanChangeResult {
  currentPlan: SubscriptionPlan | null;
  /** The plan it will switch to at `effectiveAt`, or null if nothing is pending. */
  pendingPlan: SubscriptionPlan | null;
  effectiveAt: Date | null;
  tier: string;
  status: string;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
  /**
   * Our own payment reference — the one the client stores and later exchanges
   * for a status via GET /payments/:reference. Returned with the URL so the app
   * has it before the user ever leaves for Stripe.
   */
  paymentReference: string;
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

    // The reference the client holds. Minted here so the mobile app gets one
    // identifier back with the URL and can later confirm the payment without
    // knowing anything about Stripe or about which flow it went through — book
    // checkout mints its reference the same way.
    const payment = await paymentsService.create({
      userId,
      kind: 'subscription',
      stripeCheckoutSessionId: session.id,
      amountCents: session.amount_total,
      currency: session.currency?.toUpperCase() ?? null,
    });

    logger.info('Created Stripe checkout session', {
      userId,
      plan,
      isFounding,
      priceId,
      standardPriceId,
      sessionId: session.id,
      paymentReference: payment.reference,
    });

    return {
      url: session.url,
      sessionId: session.id,
      paymentReference: payment.reference,
      plan,
      isFounding,
    };
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


  /**
   * Cancels at the end of the paid period.
   *
   * Deliberately **not** an immediate cancellation. The user has already paid
   * for the current term, and taking access away the moment they click cancel
   * both loses them value they bought and generates refund requests. Stripe
   * stops billing, they keep Plus until `currentPeriodEnd`, and the app renders
   * that from `cancelAtPeriodEnd` + `currentPeriodEnd`.
   *
   * Idempotent: cancelling an already-cancelling subscription returns the same
   * state rather than erroring, because a double-tap on a Cancel button is not
   * a mistake worth surfacing.
   */
  async cancel(
    userId: number,
    reason?: CancelReason,
    reasonOther?: string,
  ): Promise<CancellationResult> {
    assertStripeConfigured();

    const sub = await subscriptionStateService.getCurrent(userId);
    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    if (!sub.stripeSubscriptionId) {
      // Trialing or free. The 90-day trial is ours, not Stripe's, so there is
      // nothing to cancel — and saying so plainly is better than a 500 from
      // Stripe about a missing subscription.
      throw Object.assign(
        new Error('You do not have a paid subscription to cancel'),
        { statusCode: 409, code: 'NO_PAID_SUBSCRIPTION' },
      );
    }

    // A Founding Member's subscription is managed by a price schedule, and
    // Stripe rejects any cancellation set on the subscription directly while
    // that is true ("...updating any cancelation behavior directly is not
    // allowed"). Releasing detaches the schedule and leaves the subscription
    // untouched — it is not itself a cancellation, and it is a no-op for
    // everyone who has no schedule attached.
    //
    // The founding rollover is re-attached if they reactivate; see reactivate().
    await schedulesService.releaseFrom(sub.stripeSubscriptionId, userId);

    const updated = await stripe().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Mirror it locally rather than waiting for customer.subscription.updated.
    // The webhook will still arrive and write the same thing — these handlers
    // write the state the event describes rather than applying a delta, so the
    // two agreeing is the normal case, not a conflict.
    //
    // The reason is inserted inside the same transaction so a crash between
    // the state write and the audit write can't leave the cancellation
    // recorded with no reason attached — and by writing 'cancelled' here,
    // immediately, onSubscriptionChanged's "just started cancelling" branch
    // is a no-op when its webhook arrives (existing.cancelAtPeriodEnd is
    // already true), so no reason-less duplicate is inserted alongside it.
    const state = await subscriptionStateService.applyState(
      userId,
      {
        tier: sub.tier,
        status: sub.status,
        plan: sub.plan,
        priceId: sub.priceId,
        isFoundingMember: sub.isFoundingMember,
        currentPeriodEnd: periodEndOf(updated) ?? sub.currentPeriodEnd,
        cancelAtPeriodEnd: true,
        // A cancellation abandons any pending Change Plan schedule — releasing
        // it above already detached it from Stripe's side.
        pendingPlan: null,
        stripeCustomerId: sub.stripeCustomerId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
      },
      {
        reason: 'subscription_updated',
        inSameTx: reason
          ? async (tx) => {
              await tx.insert(subscriptionEvents).values({
                userId,
                event: 'cancelled',
                reason: reason === 'other' ? (reasonOther ?? 'Other') : CANCEL_REASON_LABELS[reason],
              });
            }
          : undefined,
      },
    );

    await entitlementsService.invalidate(userId);

    logger.info('Subscription cancellation scheduled', {
      userId,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      accessEndsAt: state?.currentPeriodEnd ?? sub.currentPeriodEnd,
    });

    return {
      cancelAtPeriodEnd: true,
      accessEndsAt: state?.currentPeriodEnd ?? sub.currentPeriodEnd ?? null,
      tier: state?.tier ?? sub.tier,
      status: state?.status ?? sub.status,
    };
  },

  /**
   * Stops billing for an account that is being deleted.
   *
   * Unlike `cancel`, this ends the subscription **immediately** rather than at
   * period end: there is no one left to preserve access for, and leaving a
   * cancel-at-period-end subscription behind would bill nobody's account for a
   * term nobody can use.
   *
   * The Stripe Customer is deliberately kept. Deleting it would take the
   * invoice and payment history with it, which the business still needs for
   * accounting and tax long after the user is gone.
   *
   * Returns whether anything was actually cancelled. **Never throws** — see the
   * call site in auth.service.deleteAccount for why account deletion must not
   * be blocked by Stripe being unreachable.
   */
  async terminateForAccountDeletion(userId: number): Promise<boolean> {
    const sub = await subscriptionStateService.get(userId);
    if (!sub?.stripeSubscriptionId) return false;

    // Already over — Stripe would reject a second cancellation, and there is
    // nothing left to stop.
    if (sub.status === 'cancelled' || sub.status === 'expired') return false;

    if (!isStripeConfigured()) {
      logger.error('Cannot stop billing for a deleted account — Stripe is not configured', {
        userId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        stripeCustomerId: sub.stripeCustomerId,
      });
      return false;
    }

    try {
      // A schedule-managed subscription rejects cancellation set on the
      // subscription itself, exactly as it does for the ordinary cancel path.
      await schedulesService.releaseFrom(sub.stripeSubscriptionId, userId);
      await stripe().subscriptions.cancel(sub.stripeSubscriptionId);

      logger.info('Stopped billing for a deleted account', {
        userId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
      });
      return true;
    } catch (err) {
      // Deletion proceeds anyway, so this log is the only remaining trace of a
      // subscription that may still be billing — the user row, and with it the
      // subscription id, is about to be gone. It carries every identifier
      // needed to find and cancel it by hand, and is an error rather than a
      // warning because it needs a human.
      logger.error('FAILED to stop billing for a deleted account — may still be charged', {
        userId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        stripeCustomerId: sub.stripeCustomerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  /**
   * Undoes a scheduled cancellation, while the period is still running.
   *
   * The request that always follows cancellation. Without it the only way back
   * is a fresh checkout, which for a user who cancelled by accident means a new
   * subscription, a new billing date, and — during the launch window — the loss
   * of their Founding Member price.
   */
  async reactivate(userId: number): Promise<CancellationResult> {
    assertStripeConfigured();

    const sub = await subscriptionStateService.getCurrent(userId);
    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    if (!sub.stripeSubscriptionId) {
      throw Object.assign(
        new Error('You do not have a paid subscription to resume'),
        { statusCode: 409, code: 'NO_PAID_SUBSCRIPTION' },
      );
    }

    // Once the period has ended Stripe has genuinely deleted the subscription,
    // and there is nothing left to flip — that user needs a new checkout.
    if (sub.status === 'cancelled' || sub.status === 'expired') {
      throw Object.assign(
        new Error('This subscription has already ended — start a new one to resume Plus'),
        { statusCode: 409, code: 'SUBSCRIPTION_ENDED' },
      );
    }

    const updated = await stripe().subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });

    // A founding member who cancelled had their schedule released to make the
    // cancellation possible. If they reactivate, we may need to reattach the
    // rollover — but only if the founding window has already closed. While the
    // window is still open, founding pricing continues indefinitely without any
    // schedule, and the rollover gets attached later by the invoice.paid
    // webhook when the window has actually shut. Attaching too early would
    // schedule a rollover that shouldn't happen yet.
    if (sub.isFoundingMember && !isFoundingWindowOpen()) {
      // Pass the just-updated subscription rather than its id, so
      // scheduleFoundingRollover uses the version with `cancel_at_period_end`
      // already cleared — a schedule created from a subscription inherits the
      // cancellation behaviour of whatever version Stripe reads.
      await schedulesService.scheduleFoundingRollover(updated, userId);
    }

    const state = await subscriptionStateService.applyState(
      userId,
      {
        tier: sub.tier,
        status: sub.status,
        plan: sub.plan,
        priceId: sub.priceId,
        isFoundingMember: sub.isFoundingMember,
        currentPeriodEnd: periodEndOf(updated) ?? sub.currentPeriodEnd,
        cancelAtPeriodEnd: false,
        stripeCustomerId: sub.stripeCustomerId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
      },
      { reason: 'subscription_updated' },
    );

    await entitlementsService.invalidate(userId);

    logger.info('Subscription cancellation reversed', {
      userId,
      stripeSubscriptionId: sub.stripeSubscriptionId,
    });

    return {
      cancelAtPeriodEnd: false,
      accessEndsAt: state?.currentPeriodEnd ?? sub.currentPeriodEnd ?? null,
      tier: state?.tier ?? sub.tier,
      status: state?.status ?? sub.status,
    };
  },

  /**
   * Schedules a switch to a different plan for the end of the current period.
   *
   * `plan: 'free'` is simply `cancel()` under this name — the Change Plan
   * picker's "Free Plan" option is the same backend action as the dedicated
   * Cancel Subscription flow, just confirmed with a password instead of a
   * reason. Password verification itself happens in the controller, before
   * this is called.
   */
  async changePlan(
    userId: number,
    plan: SubscriptionPlan | 'free',
    reason?: CancelReason,
    reasonOther?: string,
  ): Promise<PlanChangeResult> {
    assertStripeConfigured();

    const sub = await subscriptionStateService.getCurrent(userId);
    if (!sub) {
      throw Object.assign(new Error('Subscription not found'), { statusCode: 404 });
    }

    if (!sub.stripeSubscriptionId || (sub.status !== 'active' && sub.status !== 'past_due')) {
      throw Object.assign(
        new Error('You do not have a paid subscription to change'),
        { statusCode: 409, code: 'NO_PAID_SUBSCRIPTION' },
      );
    }

    // A schedule mid-price-change and a subscription mid-cancellation is an
    // ambiguous state — make them reactivate first.
    if (sub.cancelAtPeriodEnd) {
      throw Object.assign(
        new Error('Reactivate your subscription before changing plans'),
        { statusCode: 409, code: 'PENDING_CANCELLATION' },
      );
    }

    if (plan === 'free') {
      const cancelled = await this.cancel(userId, reason, reasonOther);
      return {
        currentPlan: sub.plan,
        pendingPlan: null,
        effectiveAt: cancelled.accessEndsAt,
        tier: cancelled.tier,
        status: cancelled.status,
      };
    }

    if (plan === sub.plan) {
      if (!sub.pendingPlan) {
        throw Object.assign(new Error('You are already on this plan'), { statusCode: 409 });
      }

      // Picking their current plan again undoes an earlier pending switch.
      // releaseFrom detaches the entire schedule — including any
      // founding-to-standard rollover that was part of it — so if the user
      // is a founding member past the offer window, reattach the rollover
      // immediately or they'd keep the founding price with no rollover at
      // all, indefinitely.
      await schedulesService.releaseFrom(sub.stripeSubscriptionId, userId);
      if (sub.isFoundingMember && !isFoundingWindowOpen()) {
        await schedulesService.scheduleFoundingRollover(sub.stripeSubscriptionId, userId);
      }

      const state = await subscriptionStateService.applyState(
        userId,
        {
          tier: sub.tier,
          status: sub.status,
          plan: sub.plan,
          priceId: sub.priceId,
          isFoundingMember: sub.isFoundingMember,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          pendingPlan: null,
          stripeCustomerId: sub.stripeCustomerId,
          stripeSubscriptionId: sub.stripeSubscriptionId,
        },
        { reason: 'subscription_updated' },
      );

      logger.info('Pending plan change undone', { userId, stripeSubscriptionId: sub.stripeSubscriptionId });

      return {
        currentPlan: state?.plan ?? sub.plan,
        pendingPlan: null,
        effectiveAt: state?.currentPeriodEnd ?? sub.currentPeriodEnd ?? null,
        tier: state?.tier ?? sub.tier,
        status: state?.status ?? sub.status,
      };
    }

    await schedulesService.schedulePlanChange(
      sub.stripeSubscriptionId,
      userId,
      plan,
      sub.isFoundingMember,
    );

    const state = await subscriptionStateService.applyState(
      userId,
      {
        tier: sub.tier,
        status: sub.status,
        plan: sub.plan,
        priceId: sub.priceId,
        isFoundingMember: sub.isFoundingMember,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        pendingPlan: plan,
        stripeCustomerId: sub.stripeCustomerId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
      },
      { reason: 'subscription_updated' },
    );

    // If applyState returned null, a concurrent writer moved the row on
    // between the getCurrent above and here — likely a webhook. The schedule
    // is already attached in Stripe, so its `customer.subscription.updated`
    // will land shortly and set pendingPlan correctly via the webhook's own
    // reconciliation. Log at error with the correlation ids so the (rare)
    // case where the webhook also fails is findable, but don't roll back the
    // Stripe write: the user's intent was recorded, and Stripe is the source
    // of truth for what will actually be billed.
    if (!state) {
      logger.error('Plan change written to Stripe but local state race prevented mirror', {
        userId,
        stripeSubscriptionId: sub.stripeSubscriptionId,
        toPlan: plan,
      });
    }

    logger.info('Plan change scheduled', {
      userId,
      stripeSubscriptionId: sub.stripeSubscriptionId,
      fromPlan: sub.plan,
      toPlan: plan,
      effectiveAt: state?.currentPeriodEnd ?? sub.currentPeriodEnd,
    });

    return {
      currentPlan: state?.plan ?? sub.plan,
      pendingPlan: state?.pendingPlan ?? plan,
      effectiveAt: state?.currentPeriodEnd ?? sub.currentPeriodEnd ?? null,
      tier: state?.tier ?? sub.tier,
      status: state?.status ?? sub.status,
    };
  },
};

/** Stripe moved the period end onto the subscription item. */
function periodEndOf(subscription: Stripe.Subscription): Date | null {
  const seconds = subscription.items.data[0]?.current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}
