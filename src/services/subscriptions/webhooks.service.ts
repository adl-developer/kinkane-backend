import Stripe from 'stripe';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, subscriptionEvents, stripeWebhookEvents } from '../../db/schema';
import type { SubscriptionStatus, SubscriptionPlan } from '../../db/schema';
import { config } from '../../config';
import { stripe, planForPriceId, isFoundingPriceId, resolvePrice } from '../../lib/stripe';
import { logger } from '../../lib/logger';
import { enqueueEmail } from '../../lib/email-queue';
import { subscriptionStateService } from './state.service';
import { entitlementsService } from './entitlements.service';
import { schedulesService, scheduleIdOf } from './schedules.service';
import { orderWebhooksService } from '../commerce/order-webhooks.service';
import { paymentsService } from '../payments.service';

/**
 * How long a claim can hold before it's considered abandoned and re-runnable.
 * Set to comfortably longer than any handler could plausibly take (the slowest
 * involve a small handful of Stripe API calls, well under 30s), and shorter
 * than Stripe's redelivery cadence, so a still-running instance is never
 * preempted by a redelivery that races with it.
 */
const STALE_CLAIM_SECONDS = 60;

/**
 * Stripe webhook ingestion.
 *
 * Stripe is the source of truth for billing; this file's whole job is to keep
 * our subscription rows in step with it. Three rules hold everywhere below:
 *
 *  1. **Idempotent.** Stripe delivers at-least-once. Every event id is claimed
 *     in stripe_webhook_events before its handler runs; a duplicate loses that
 *     race and is skipped.
 *  2. **Order-independent.** Deliveries arrive out of order, so handlers write
 *     the state the event describes rather than applying a delta, and stale
 *     deliveries are dropped by comparing against the subscription object
 *     Stripe sends with the event.
 *  3. **Never guess whose subscription this is.** Resolution is by stored
 *     customer id, then by metadata.userId. If neither matches we log and stop —
 *     granting Plus to the wrong account is worse than not granting it.
 */

/** Maps Stripe's subscription status onto ours. */
function mapStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      // We don't run Stripe trials (the 90-day trial is in-app), but if one is
      // ever configured in the dashboard it must still read as entitled.
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'cancelled';
    case 'paused':
      return 'expired';
    default:
      return 'expired';
  }
}

/**
 * Whether a status should still see Plus features. `past_due` deliberately
 * does: Stripe retries a failed payment for days, and cutting someone off on
 * the first failed charge — usually an expired card — costs more in churn than
 * the few days of access it saves.
 */
function tierForStatus(status: SubscriptionStatus): 'free' | 'plus' {
  return status === 'active' || status === 'past_due' || status === 'trialing' ? 'plus' : 'free';
}

function firstPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null;
}

function periodEnd(subscription: Stripe.Subscription): Date | null {
  const seconds = subscription.items.data[0]?.current_period_end;
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

function customerId(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export const webhooksService = {
  /**
   * Verifies the signature and returns the parsed event.
   *
   * Takes the raw body — it must not have been through express.json, since the
   * signature is computed over the exact bytes Stripe sent.
   */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!config.stripe.webhookSecret) {
      throw Object.assign(new Error('Stripe webhooks are not configured'), { statusCode: 503 });
    }
    try {
      return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
    } catch (err) {
      // A bad signature is either a misconfigured secret or someone poking at
      // the endpoint. Either way it's a 400 and it never reaches a handler.
      throw Object.assign(new Error('Invalid Stripe webhook signature'), {
        statusCode: 400,
        cause: err,
      });
    }
  },

  /**
   * Claims an event id, returning true when this delivery should be handled.
   *
   * Three cases:
   *   1. No row exists → insert one and claim (first delivery).
   *   2. Row exists with `processed_at` set → skip (handler already ran to
   *      completion — this is a genuine duplicate).
   *   3. Row exists with `processed_at` NULL — a prior attempt started but
   *      didn't reach `markProcessed`. If it's older than STALE_CLAIM_SECONDS,
   *      the process holding it has almost certainly died (Stripe's own
   *      redelivery cadence is > that), so reclaim and re-run. Otherwise
   *      another instance is currently processing this event, so skip.
   *
   * The reclaim path is what makes Stripe's automatic redelivery actually
   * work as a crash-recovery mechanism. Without it, a handler crash between
   * the claim and `markProcessed` leaves half-completed side effects that
   * never get finished, since every future delivery is dropped as duplicate.
   */
  async claimEvent(event: Stripe.Event): Promise<boolean> {
    const claimed = await db
      .insert(stripeWebhookEvents)
      .values({
        eventId: event.id,
        type: event.type,
        payload: event.data.object as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: stripeWebhookEvents.eventId,
        set: { receivedAt: sql`now()`, payload: sql`EXCLUDED.payload` },
        setWhere: sql`${stripeWebhookEvents.processedAt} IS NULL AND ${stripeWebhookEvents.receivedAt} < now() - interval '${sql.raw(String(STALE_CLAIM_SECONDS))} seconds'`,
      })
      .returning({ eventId: stripeWebhookEvents.eventId });

    return claimed.length > 0;
  },

  async markProcessed(eventId: string, error?: string): Promise<void> {
    await db
      .update(stripeWebhookEvents)
      .set({ processedAt: new Date(), ...(error && { error: error.slice(0, 1000) }) })
      .where(eq(stripeWebhookEvents.eventId, eventId));
  },

  /**
   * Routes an event to its handler. Unhandled types are recorded and ignored,
   * so enabling extra events in the Stripe dashboard is harmless.
   */
  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        // One endpoint serves both products. `mode` is the discriminator:
        // 'subscription' is Kinkané Plus, 'payment' is a book order. Each
        // handler returns immediately if the session is not its own, so adding
        // a second webhook endpoint (and a second idempotency table) was never
        // necessary.
        await this.onCheckoutCompleted(event, event.data.object as Stripe.Checkout.Session);
        await orderWebhooksService.onCheckoutCompleted(
          event,
          event.data.object as Stripe.Checkout.Session,
        );
        break;
      case 'checkout.session.expired': {
        // Applies to both kinds: the order handler ignores subscription
        // sessions, while the payment reference is settled for either.
        const expired = event.data.object as Stripe.Checkout.Session;
        await paymentsService.markFromSession(
          expired.id,
          'expired',
          'The payment window closed before it was completed',
        );
        await orderWebhooksService.onCheckoutExpired(expired);
        break;
      }
      case 'payment_intent.payment_failed':
        await orderWebhooksService.onPaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.resumed':
      case 'customer.subscription.paused':
        await this.onSubscriptionChanged(event, event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(event, event.data.object as Stripe.Subscription);
        break;
      case 'invoice.paid':
        await this.onInvoicePaid(event, event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await this.onInvoicePaymentFailed(event, event.data.object as Stripe.Invoice);
        break;
      case 'charge.refunded':
        await this.onChargeRefunded(event, event.data.object as Stripe.Charge);
        await orderWebhooksService.onChargeRefunded(event.data.object as Stripe.Charge);
        break;
      default:
        logger.info('Ignoring unhandled Stripe event type', { type: event.type, eventId: event.id });
    }
  },

  // ── User resolution ────────────────────────────────────────────────────────

  /**
   * Finds the user an event belongs to: stored customer id first, then the
   * metadata we set at checkout. Returns null rather than guessing.
   */
  async resolveUserId(
    stripeCustomerId: string | null,
    metadata?: Stripe.Metadata | null,
  ): Promise<number | null> {
    if (stripeCustomerId) {
      const sub = await subscriptionStateService.getByStripeCustomerId(stripeCustomerId);
      if (sub) return sub.userId;
    }

    const fromMetadata = Number(metadata?.userId);
    if (Number.isInteger(fromMetadata) && fromMetadata > 0) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, fromMetadata))
        .limit(1);
      if (user) return user.id;
    }

    return null;
  },

  // ── Handlers ───────────────────────────────────────────────────────────────

  /**
   * The conversion moment: a user has paid for the first time.
   *
   * Re-fetches the subscription from Stripe rather than trusting the session
   * alone — the session carries an id, not the full billing state, and this is
   * the write that grants entitlement.
   */
  async onCheckoutCompleted(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<void> {
    if (session.mode !== 'subscription') return;

    // The client-facing payment reference. Settled here rather than deeper in
    // the flow so it resolves even if subscription resolution below bails out —
    // the money did arrive, and the app asking "did my payment work" deserves
    // the true answer regardless of what we then failed to do with it.
    await paymentsService.markFromSession(session.id, 'succeeded');

    const stripeCustomerId = customerId(session.customer);
    const userId =
      Number(session.client_reference_id) ||
      (await this.resolveUserId(stripeCustomerId, session.metadata));

    if (!userId || !Number.isInteger(userId)) {
      logger.error('Checkout completed for an unresolvable user', {
        eventId: event.id,
        sessionId: session.id,
        stripeCustomerId,
      });
      return;
    }

    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

    if (!subscriptionId) {
      logger.error('Checkout session completed without a subscription', {
        eventId: event.id,
        sessionId: session.id,
      });
      return;
    }

    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    const priceId = firstPriceId(subscription);
    const isFounding = isFoundingPriceId(priceId);

    const updated = await subscriptionStateService.applyState(
      userId,
      {
        tier: tierForStatus(mapStatus(subscription.status)),
        status: mapStatus(subscription.status),
        plan: planForPriceId(priceId),
        priceId,
        isFoundingMember: isFounding,
        currentPeriodEnd: periodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
        // trial_ends_at is deliberately left alone — it's the historical record
        // of the in-app trial, not a live billing field.
      },
      {
        reason: 'checkout_completed',
        sourceEventId: event.id,
        inSameTx: async (tx) => {
          await tx.insert(subscriptionEvents).values({
            userId,
            event: 'converted',
            amountCents: session.amount_total,
            currency: session.currency,
            stripeEventId: event.id,
            reason: isFounding ? 'Founding Member checkout' : 'Checkout completed',
          });
        },
      },
    );

    if (!updated) {
      logger.error('Checkout completed but the subscription row could not be updated', {
        eventId: event.id,
        userId,
      });
      return;
    }

    await entitlementsService.invalidate(userId);

    if (isFounding) {
      await schedulesService.attachFounding(subscription, userId);
    }

    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user) {
      await enqueueEmail('subscription-confirmed', {
        to: user.email,
        name: user.name,
        plan: (planForPriceId(priceId) ?? 'monthly') as SubscriptionPlan,
        isFounding,
        currentPeriodEnd: periodEnd(subscription)?.toISOString() ?? null,
      }).catch((err) => {
        logger.error('Failed to enqueue subscription confirmation email', {
          userId,
          error: (err as Error).message,
        });
      });
    }

    logger.info('Subscription activated from checkout', {
      userId,
      subscriptionId: subscription.id,
      plan: planForPriceId(priceId),
      isFounding,
    });
  },

  /**
   * Any change to the subscription itself: plan switch, cancel-at-period-end
   * toggled in the portal, dunning status changes, and the Founding→standard
   * rollover when the schedule advances.
   */
  async onSubscriptionChanged(event: Stripe.Event, subscription: Stripe.Subscription): Promise<void> {
    const stripeCustomerId = customerId(subscription.customer);
    const userId = await this.resolveUserId(stripeCustomerId, subscription.metadata);

    if (!userId) {
      logger.error('Subscription change for an unresolvable user', {
        eventId: event.id,
        subscriptionId: subscription.id,
        stripeCustomerId,
      });
      return;
    }

    const existing = await subscriptionStateService.get(userId);
    // Out-of-order delivery for a subscription they've since replaced. Writing
    // it would resurrect dead state.
    if (
      existing?.stripeSubscriptionId &&
      existing.stripeSubscriptionId !== subscription.id &&
      subscription.status === 'canceled'
    ) {
      logger.info('Ignoring stale event for a superseded subscription', {
        eventId: event.id,
        userId,
        eventSubscriptionId: subscription.id,
        currentSubscriptionId: existing.stripeSubscriptionId,
      });
      return;
    }

    const priceId = firstPriceId(subscription);
    const status = mapStatus(subscription.status);
    const plan = planForPriceId(priceId);
    const planChanged = Boolean(existing && existing.priceId && existing.priceId !== priceId);
    // No schedule left managing this subscription means any pending Change
    // Plan switch has either taken effect (phase advanced) or been abandoned
    // (released elsewhere) — either way it's no longer pending. `undefined`
    // while a schedule is still running leaves whatever is already stored
    // untouched, since this generic handler didn't set it in the first place.
    const scheduleId = scheduleIdOf(subscription);

    const startedCancelling = subscription.cancel_at_period_end && !existing?.cancelAtPeriodEnd;
    const resumed = !subscription.cancel_at_period_end && !!existing?.cancelAtPeriodEnd;

    const updated = await subscriptionStateService.applyState(
      userId,
      {
        tier: tierForStatus(status),
        status,
        plan,
        priceId,
        isFoundingMember: existing?.isFoundingMember || isFoundingPriceId(priceId),
        currentPeriodEnd: periodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        pendingPlan: scheduleId ? undefined : null,
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
      },
      {
        reason: 'subscription_updated',
        sourceEventId: event.id,
        inSameTx: async (tx) => {
          if (planChanged) {
            await tx.insert(subscriptionEvents).values({
              userId,
              event: 'plan_changed',
              stripeEventId: event.id,
              reason: `Price changed from ${existing?.priceId} to ${priceId}`,
            });
          }
          if (startedCancelling) {
            await tx.insert(subscriptionEvents).values({
              userId,
              event: 'cancelled',
              stripeEventId: event.id,
              reason: 'Cancellation scheduled for end of the current period',
            });
          }
          if (resumed) {
            await tx.insert(subscriptionEvents).values({
              userId,
              event: 'resumed',
              stripeEventId: event.id,
              reason: 'Cancellation reversed before the period ended',
            });
          }
        },
      },
    );

    if (!updated) return;
    await entitlementsService.invalidate(userId);

    // Email is intentionally outside the transaction: enqueueing it is a
    // Redis write, and a Redis blip must not roll back a Stripe-driven state
    // change we've already committed to. If the email fails to enqueue the
    // record of the cancellation itself is still there, and the log tells
    // support what to do about it.
    if (startedCancelling) {
      const [user] = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (user) {
        await enqueueEmail('subscription-cancelled', {
          to: user.email,
          name: user.name,
          accessEndsAt: periodEnd(subscription)?.toISOString() ?? null,
        }).catch((err) => {
          logger.error('Failed to enqueue cancellation email', {
            userId,
            error: (err as Error).message,
          });
        });
      }
    }
  },

  /** The subscription has actually ended. Access stops here. */
  async onSubscriptionDeleted(event: Stripe.Event, subscription: Stripe.Subscription): Promise<void> {
    const stripeCustomerId = customerId(subscription.customer);
    const userId = await this.resolveUserId(stripeCustomerId, subscription.metadata);

    if (!userId) {
      logger.error('Subscription deletion for an unresolvable user', {
        eventId: event.id,
        subscriptionId: subscription.id,
      });
      return;
    }

    const existing = await subscriptionStateService.get(userId);
    // They already resubscribed — this is the old subscription ending, and
    // acting on it would revoke access they've paid for.
    if (existing?.stripeSubscriptionId && existing.stripeSubscriptionId !== subscription.id) {
      logger.info('Ignoring deletion of a superseded subscription', {
        eventId: event.id,
        userId,
        eventSubscriptionId: subscription.id,
        currentSubscriptionId: existing.stripeSubscriptionId,
      });
      return;
    }

    const updated = await subscriptionStateService.applyState(
      userId,
      {
        tier: 'free',
        status: 'cancelled',
        cancelAtPeriodEnd: false,
        // stripe_subscription_id is kept, not cleared: it's how this row is
        // traced back to its Stripe history, and clearing it would make the
        // trial-expiry guard treat a former subscriber as a fresh trialist.
      },
      {
        reason: 'subscription_deleted',
        sourceEventId: event.id,
        inSameTx: async (tx) => {
          await tx.insert(subscriptionEvents).values({
            userId,
            event: 'cancelled',
            stripeEventId: event.id,
            reason: 'Subscription ended',
          });
        },
      },
    );

    if (!updated) return;
    await entitlementsService.invalidate(userId);

    logger.info('Subscription ended', { userId, subscriptionId: subscription.id });
  },

  /** A renewal (or the first invoice) was paid. Extends the paid period. */
  async onInvoicePaid(event: Stripe.Event, invoice: Stripe.Invoice): Promise<void> {
    const stripeCustomerId = customerId(invoice.customer);
    const userId = await this.resolveUserId(stripeCustomerId, invoice.metadata);
    if (!userId) return;

    const subscriptionId = this.invoiceSubscriptionId(invoice);
    if (!subscriptionId) return;

    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    const priceId = firstPriceId(subscription);
    const status = mapStatus(subscription.status);

    const updated = await subscriptionStateService.applyState(
      userId,
      {
        tier: tierForStatus(status),
        status,
        plan: planForPriceId(priceId),
        priceId,
        currentPeriodEnd: periodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        stripeCustomerId,
        stripeSubscriptionId: subscription.id,
      },
      {
        reason: 'invoice_paid',
        sourceEventId: event.id,
        inSameTx: async (tx) => {
          await tx.insert(subscriptionEvents).values({
            userId,
            event: 'renewed',
            amountCents: invoice.amount_paid,
            currency: invoice.currency,
            stripeInvoiceId: invoice.id,
            stripeEventId: event.id,
          });
        },
      },
    );

    if (updated) await entitlementsService.invalidate(userId);
  },

  /**
   * A charge failed. Stripe will retry on its own schedule, so this marks them
   * past_due — which keeps Plus access during the grace window — and emails
   * them a portal link to fix the card.
   */
  async onInvoicePaymentFailed(event: Stripe.Event, invoice: Stripe.Invoice): Promise<void> {
    const stripeCustomerId = customerId(invoice.customer);
    const userId = await this.resolveUserId(stripeCustomerId, invoice.metadata);
    if (!userId) return;

    const existing = await subscriptionStateService.get(userId);
    if (!existing) return;

    const updated = await subscriptionStateService.applyState(
      userId,
      {
        // Tier deliberately stays plus — see tierForStatus.
        tier: 'plus',
        status: 'past_due',
      },
      {
        reason: 'payment_failed',
        sourceEventId: event.id,
        inSameTx: async (tx) => {
          await tx.insert(subscriptionEvents).values({
            userId,
            event: 'payment_failed',
            amountCents: invoice.amount_due,
            currency: invoice.currency,
            stripeInvoiceId: invoice.id,
            stripeEventId: event.id,
            reason: 'Invoice payment failed',
          });
        },
      },
    );

    if (updated) await entitlementsService.invalidate(userId);

    const [user] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (user) {
      await enqueueEmail('subscription-payment-failed', {
        to: user.email,
        name: user.name,
        amountCents: invoice.amount_due ?? null,
        currency: invoice.currency ?? null,
      }).catch((err) => {
        logger.error('Failed to enqueue payment failure email', {
          userId,
          error: (err as Error).message,
        });
      });
    }

    logger.warn('Subscription payment failed', { userId, invoiceId: invoice.id });
  },

  /**
   * Recorded for the audit trail only. A refund does not revoke access on its
   * own — if it should, the subscription is cancelled too and that arrives as
   * its own event.
   */
  async onChargeRefunded(event: Stripe.Event, charge: Stripe.Charge): Promise<void> {
    const stripeCustomerId = customerId(charge.customer);
    const userId = await this.resolveUserId(stripeCustomerId, charge.metadata);
    if (!userId) return;

    await db.insert(subscriptionEvents).values({
      userId,
      event: 'refunded',
      amountCents: charge.amount_refunded,
      currency: charge.currency,
      stripeEventId: event.id,
      reason: 'Charge refunded',
    });

    logger.info('Refund recorded', { userId, chargeId: charge.id, amount: charge.amount_refunded });
  },

  /**
   * The subscription an invoice belongs to. Stripe moved this off the top-level
   * `subscription` field in recent API versions, so both shapes are handled.
   */
  invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
    const parent = invoice.parent as { subscription_details?: { subscription?: string | { id: string } } } | null;
    const fromParent = parent?.subscription_details?.subscription;
    if (fromParent) return typeof fromParent === 'string' ? fromParent : fromParent.id;

    const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
    if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;

    return null;
  },
};
