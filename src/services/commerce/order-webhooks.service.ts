/**
 * The order half of the Stripe webhook.
 *
 * Deliberately *not* a second endpoint. Stripe delivery, signature
 * verification and the `stripe_webhook_events` idempotency claim all live in
 * subscriptions/webhooks.service.ts, and duplicating them would mean two places
 * where an event can be double-processed. This module is called from that
 * dispatcher and returns immediately for anything that is not a book order.
 *
 * The three rules from the subscription side hold here unchanged:
 *   1. Idempotent — the event id is claimed before any handler runs, and
 *      `markPaid` will not transition an order twice.
 *   2. Order-independent — handlers write the state the event describes.
 *   3. Never guess whose order this is — resolution is by `metadata.orderId`
 *      and nothing else.
 */
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { orders, orderItems } from '../../db/schema';
import { logger } from '../../lib/logger';
import { enqueueEmail } from '../../lib/email-queue';
import { takeGuestToken } from '../../lib/guest-token-handoff';
import { ordersService } from './orders.service';
import { paymentsService } from '../payments.service';
import { enqueueFulfilment } from '../../lib/fulfilment-queue';

/** Whether a Checkout Session belongs to the shop rather than to Plus. */
function isOrderSession(session: Stripe.Checkout.Session): boolean {
  return session.mode === 'payment' && session.metadata?.kind === 'order';
}

function orderIdFrom(metadata: Stripe.Metadata | null | undefined): number | null {
  const id = Number(metadata?.orderId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export const orderWebhooksService = {
  /**
   * Payment succeeded: record it, close the cart, log the purchase signal, and
   * hand fulfilment to the queue.
   *
   * Fulfilment is enqueued rather than awaited. Submitting to Gardners is an
   * SFTP round trip; blocking here would time the webhook out and make Stripe
   * redeliver an event we had already half-processed.
   */
  async onCheckoutCompleted(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<void> {
    if (!isOrderSession(session)) return;

    const orderId = orderIdFrom(session.metadata) ?? Number(session.client_reference_id) ?? null;

    if (!orderId || !Number.isInteger(orderId)) {
      logger.error('Order checkout completed for an unresolvable order', {
        eventId: event.id,
        sessionId: session.id,
      });
      return;
    }

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) {
      logger.error('Order checkout completed for an order that does not exist', {
        eventId: event.id,
        sessionId: session.id,
        orderId,
      });
      return;
    }

    // Stripe moved collected shipping from `shipping_details` to
    // `collected_information.shipping_details`. Read both so the handler works
    // regardless of which shape the pinned API version sends.
    const shipping =
      session.collected_information?.shipping_details ??
      (session as unknown as { shipping_details?: Stripe.Checkout.Session.CollectedInformation.ShippingDetails })
        .shipping_details;

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);

    // Settle the client-facing payment reference first. It is a read-only
    // status surface, so it is safe to write even on a redelivered event, and
    // doing it before the idempotency gate below means the app's confirm call
    // gets the right answer even if the order side was already processed.
    await paymentsService.markFromSession(session.id, 'succeeded');

    await ordersService.markPaid(orderId, {
      paymentIntentId,
      shipping: {
        name: shipping?.name,
        line1: shipping?.address?.line1,
        line2: shipping?.address?.line2,
        city: shipping?.address?.city,
        region: shipping?.address?.state,
        postcode: shipping?.address?.postal_code,
        countryCode: shipping?.address?.country,
      },
    });

    // Deliberately no `if (transitioned)` gate here. `markPaid` returns false
    // on a redelivery because the order is already `paid` — but each of the
    // three side effects below is naturally idempotent (cart convert is a
    // WHERE-status='active' no-op, purchase signals use onConflictDoNothing,
    // fulfilment uses jobId dedup in BullMQ), and gating them on a
    // first-transition flag meant a crash between markPaid and this line
    // permanently left the cart un-converted, the signals unrecorded and the
    // order never sent to the supplier — Stripe would redeliver, but by then
    // the transition had happened on the earlier attempt and the retry gave up.
    await ordersService.convertCart(order.cartId);
    // Personalisation signals need somebody to personalise for. A guest order
    // simply has nowhere to record them — not an error, just an absence. They
    // are not replayed if the order is later claimed: the claim happens after
    // the fact and inferring taste from a months-old purchase is not worth
    // reaching back into the interaction log for.
    if (order.userId !== null) {
      await ordersService.recordPurchaseSignals(order.userId, orderId);
    }

    logger.info('Order paid', {
      orderId,
      userId: order.userId,
      currency: order.presentmentCurrency,
      totalMinor: order.totalMinor,
    });

    await sendOrderConfirmation(orderId);

    enqueueFulfilment(orderId);
  },

  /** The buyer walked away and Stripe let the session lapse. */
  async onCheckoutExpired(session: Stripe.Checkout.Session): Promise<void> {
    if (!isOrderSession(session)) return;

    const orderId = orderIdFrom(session.metadata);
    if (!orderId) return;

    const order = await ordersService.findByStripeSessionId(session.id);
    if (!order || order.status !== 'pending_payment') return;

    await paymentsService.markFromSession(session.id, 'expired', 'The payment window closed before it was completed');
    await ordersService.setStatus(orderId, 'expired');
    logger.info('Checkout session expired', { orderId, sessionId: session.id });
  },

  /**
   * A payment attempt failed. The order stays reachable rather than being
   * deleted — the buyer may simply try another card, and `payment_failed` is
   * what tells support the difference between "never tried" and "tried and the
   * bank said no".
   */
  async onPaymentFailed(intent: Stripe.PaymentIntent): Promise<void> {
    const orderId = orderIdFrom(intent.metadata);
    if (!orderId) return;

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order || order.status !== 'pending_payment') return;

    await ordersService.setStatus(orderId, 'payment_failed');
    logger.info('Order payment failed', {
      orderId,
      reason: intent.last_payment_error?.message ?? null,
    });
  },

  /**
   * A refund was issued — almost always by hand in the Stripe dashboard, since
   * there is no automated refund path yet (the dropship module has no
   * cancellation flow).
   *
   * Recording it matters beyond bookkeeping: `refunded` is excluded from
   * SOLD_ORDER_STATUSES, so a refund correctly removes those copies from the
   * bestseller chart.
   */
  async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const paymentIntentId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : (charge.payment_intent?.id ?? null);

    if (!paymentIntentId) return;

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);

    if (!order) return;

    // A partial refund is not a cancelled sale — the customer is still getting
    // most of what they bought, and zeroing the order would misstate both the
    // history and the chart.
    if (charge.amount_refunded < charge.amount) {
      logger.info('Partial refund recorded against an order — status unchanged', {
        orderId: order.id,
        refunded: charge.amount_refunded,
        total: charge.amount,
      });
      return;
    }

    await ordersService.setStatus(order.id, 'refunded');
    logger.info('Order refunded', { orderId: order.id });
  },
};

/**
 * Queues the confirmation email for a paid order.
 *
 * Never throws. A webhook that fails because an email could not be composed
 * gets retried by Stripe, and every retry re-runs the side effects above — so a
 * missing email would turn into duplicate fulfilment attempts. The email is the
 * least important thing in this function and must behave like it.
 *
 * Safe against Stripe's redeliveries by consequence rather than by design: the
 * guest token is taken from Redis and deleted, so a second delivery sends an
 * email without a tracking section rather than a second copy of the credential.
 * A duplicate confirmation is untidy; a duplicate credential in an inbox is not.
 */
async function sendOrderConfirmation(orderId: number): Promise<void> {
  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return;

    const items = await db
      .select({
        title: orderItems.titleSnapshot,
        contributor: orderItems.contributorSnapshot,
        quantity: orderItems.quantity,
        lineTotalMinor: orderItems.lineTotalMinor,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    const buyerName = order.shippingName ?? null;

    const shippingLines = [
      order.shippingName,
      order.shippingLine1,
      order.shippingLine2,
      order.shippingCity,
      order.shippingPostcode,
      order.shippingCountryCode,
    ].filter((line): line is string => Boolean(line));

    await enqueueEmail('order-confirmed', {
      to: order.contactEmail,
      name: buyerName,
      payload: {
        reference: order.reference,
        currency: order.presentmentCurrency,
        subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor,
        shippingMinor: order.shippingMinor,
        taxMinor: order.taxMinor,
        totalMinor: order.totalMinor,
        items,
        shippingLines,
        // Everyone gets the short code — it is an identifier, not a credential.
        trackingCode: order.trackingCode,
        // Guests only — takeGuestToken returns null for a signed-in buyer,
        // whose order lives under their account instead.
        accessToken: await takeGuestToken(orderId),
      },
    });
  } catch (err) {
    logger.error('Failed to queue order confirmation email', {
      orderId,
      error: (err as Error).message,
    });
  }
}
