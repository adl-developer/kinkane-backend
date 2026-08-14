/**
 * Turning a cart into a paid order.
 *
 * The ordering of steps below is the whole design, and it is driven by one
 * constraint: **shipping cost and tax both depend on the destination, but
 * Stripe only collects an address after the price is fixed.** Rather than
 * guess and reconcile afterwards, the destination *country* is asked for by our
 * own API up front, everything is priced against it, and Stripe's address
 * collection is then locked to that single country. The address the buyer types
 * can vary in every way except the one we priced on.
 *
 * The alternative — Stripe's dynamic `shipping_options` — would mean expressing
 * every shipping and tax rule in Stripe's model rather than in our own
 * configuration, which is the thing the env-driven design exists to avoid.
 */
import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { users, carts, cartItems, orders, orderItems, type Order } from '../../db/schema';
import { config } from '../../config';
import { stripe, assertStripeConfigured } from '../../lib/stripe';
import { withQueryParam } from '../../lib/url';
import { logger } from '../../lib/logger';
import { checkoutService as subscriptionCheckoutService } from '../subscriptions/checkout.service';
import { paymentsService } from '../payments.service';
import { availabilityService, type UnbuyableReason } from './availability.service';
import { isDeliverableCountry } from './gardners-countries';
import { quoteOrder, resolveCurrency, normalizeCountry, toPresentment } from './pricing';

export interface CheckoutChange {
  bookId: number;
  title: string | null;
  kind: 'price_changed' | 'unavailable' | 'quantity_reduced';
  reason?: UnbuyableReason;
  previousUnitPriceMinor?: number;
  unitPriceMinor?: number;
  previousQuantity?: number;
  quantity?: number;
}

export interface CheckoutResult {
  url: string;
  orderId: number;
  sessionId: string;
  /**
   * The client-held key for confirming this payment later, via
   * GET /payments/:reference. Identical in shape to the one the subscription
   * checkout returns, so the app stores one string and never branches on which
   * kind of thing it bought.
   */
  paymentReference: string;
  currency: string;
  totalMinor: number;
}

function httpError(message: string, statusCode: number, code?: string, extra?: object): Error {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

export const commerceCheckoutService = {
  /**
   * Validates, prices, persists and hands back a Stripe Checkout URL.
   *
   * Throws a 409 carrying `changes` if anything moved since the cart was last
   * looked at. The cart is repaired in place before that throw, so the client's
   * retry — after the user has seen what changed — succeeds without them having
   * to rebuild the basket.
   */
  async start(
    userId: number,
    options: { destinationCountry: string; currency?: string | null },
  ): Promise<CheckoutResult> {
    assertStripeConfigured();

    const destinationCountry = normalizeCountry(options.destinationCountry);
    if (!destinationCountry) {
      throw httpError('A valid destination country is required', 400, 'INVALID_COUNTRY');
    }

    // Refuse a destination we cannot address a Gardners parcel to — here,
    // before a Stripe session exists, rather than at fulfilment. Discovering it
    // after the card is charged means refunding an order we were never able to
    // ship, and refunds are currently a manual Stripe action plus a phone call.
    // The fix for a genuine gap is an env entry, not a deploy: see
    // GARDNERS_COUNTRY_NAMES_EXTRA.
    if (!isDeliverableCountry(destinationCountry)) {
      logger.warn('Refused checkout to a country with no Gardners name mapping', {
        userId,
        destinationCountry,
      });
      throw httpError(
        'We cannot ship to that country yet',
        409,
        'COUNTRY_NOT_SUPPORTED',
      );
    }

    const [cart] = await db
      .select()
      .from(carts)
      .where(eq(carts.userId, userId))
      .limit(1);

    if (!cart || cart.status !== 'active') {
      throw httpError('Your cart is empty', 400, 'CART_EMPTY');
    }

    const items = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    if (items.length === 0) {
      throw httpError('Your cart is empty', 400, 'CART_EMPTY');
    }

    const currency = resolveCurrency({
      requested: options.currency,
      countryCode: destinationCountry,
    });

    // The binding availability check: real destination, live price, live stock.
    const { buyable, rejected } = await availabilityService.check(
      items.map((item) => item.bookId),
      destinationCountry,
    );

    const changes: CheckoutChange[] = [];

    for (const item of items) {
      const live = buyable.get(item.bookId);

      if (!live) {
        changes.push({
          bookId: item.bookId,
          title: null,
          kind: 'unavailable',
          reason: rejected.get(item.bookId),
        });
        continue;
      }

      if (live.unitPriceGbpPence !== item.unitPriceGbpPence) {
        changes.push({
          bookId: item.bookId,
          title: live.title,
          kind: 'price_changed',
          previousUnitPriceMinor: toPresentment(item.unitPriceGbpPence, currency),
          unitPriceMinor: toPresentment(live.unitPriceGbpPence, currency),
        });
      }

      if (live.stockQty < item.quantity) {
        changes.push({
          bookId: item.bookId,
          title: live.title,
          kind: 'quantity_reduced',
          previousQuantity: item.quantity,
          quantity: live.stockQty,
        });
      }
    }

    if (changes.length > 0) {
      await this.repairCart(cart.id, items, buyable);
      throw httpError('Some items in your cart changed', 409, 'CART_CHANGED', {
        details: { changes },
      });
    }

    const quote = quoteOrder({
      lines: items.map((item) => {
        const live = buyable.get(item.bookId)!;
        return {
          bookId: item.bookId,
          isbn13: live.isbn13,
          quantity: item.quantity,
          unitPriceGbpPence: live.unitPriceGbpPence,
        };
      }),
      destinationCountry,
      currency,
    });

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw httpError('User not found', 404);

    const order = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(orders)
        .values({
          userId,
          status: 'pending_payment',
          subtotalGbpPence: quote.subtotalGbpPence,
          shippingGbpPence: quote.shippingGbpPence,
          taxGbpPence: quote.taxGbpPence,
          totalGbpPence: quote.totalGbpPence,
          presentmentCurrency: quote.currency,
          subtotalMinor: quote.subtotalMinor,
          shippingMinor: quote.shippingMinor,
          taxMinor: quote.taxMinor,
          totalMinor: quote.totalMinor,
          fxRate: String(quote.fxRate),
          fxCapturedAt: quote.fxCapturedAt,
          taxRatePercent: String(quote.taxRatePercent),
          taxSource: quote.taxSource,
          shippingRule: quote.shippingRule,
          shippingCountryCode: destinationCountry,
          contactEmail: user.email,
        })
        .returning();

      await tx.insert(orderItems).values(
        quote.lines.map((line) => {
          const live = buyable.get(line.bookId)!;
          return {
            orderId: created.id,
            bookId: line.bookId,
            isbn13: line.isbn13,
            quantity: line.quantity,
            unitPriceGbpPence: line.unitPriceGbpPence,
            lineTotalGbpPence: line.lineTotalGbpPence,
            unitPriceMinor: line.unitPriceMinor,
            lineTotalMinor: line.lineTotalMinor,
            titleSnapshot: live.title.slice(0, 500),
            contributorSnapshot: live.contributor?.slice(0, 500) ?? null,
          };
        }),
      );

      return created;
    });

    const session = await this.createSession(userId, order, quote.lines.map((line) => ({
      name: buyable.get(line.bookId)!.title,
      contributor: buyable.get(line.bookId)!.contributor,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
    })));

    // Order-side link back to the Stripe session and the payment row that
    // fronts it. Both writes are committed together: if only one landed, a
    // webhook arriving before the follow-up either couldn't find the order
    // for its session id (session id column not set) or couldn't find the
    // payment behind the reference we handed the client (payment row not
    // inserted) — the client would see 'payment not found' for a checkout
    // that in fact went through.
    const payment = await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({ stripeCheckoutSessionId: session.id, updatedAt: new Date() })
        .where(eq(orders.id, order.id));

      return paymentsService.create(
        {
          userId,
          kind: 'order',
          stripeCheckoutSessionId: session.id,
          amountCents: quote.totalMinor,
          currency: quote.currency,
          orderId: order.id,
        },
        tx,
      );
    });

    logger.info('Checkout session created', {
      orderId: order.id,
      userId,
      currency: quote.currency,
      totalMinor: quote.totalMinor,
      destinationCountry,
      paymentReference: payment.reference,
    });

    return {
      url: session.url!,
      orderId: order.id,
      sessionId: session.id,
      paymentReference: payment.reference,
      currency: quote.currency,
      totalMinor: quote.totalMinor,
    };
  },

  /**
   * Builds the Stripe session.
   *
   * Line items are built from what the server just computed — never from the
   * request body. This is the same rule `resolvePrice()` enforces on the
   * subscription side, and it is what stops a crafted request buying a book at
   * a price of its own choosing.
   */
  async createSession(
    userId: number,
    order: Order,
    lines: { name: string; contributor: string | null; quantity: number; unitPriceMinor: number }[],
  ): Promise<Stripe.Checkout.Session> {
    const customerId = await subscriptionCheckoutService.ensureStripeCustomer(userId);
    const currency = order.presentmentCurrency.toLowerCase();

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = lines.map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency,
        unit_amount: line.unitPriceMinor,
        product_data: {
          name: line.name.slice(0, 250),
          ...(line.contributor && { description: line.contributor.slice(0, 250) }),
        },
      },
    }));

    // Tax as its own line rather than a Stripe TaxRate object: the rate comes
    // from our own env table (see VAT_RATES), and mirroring it into Stripe's
    // tax objects would create a second place for it to be wrong. When Stripe
    // Tax replaces the env table, this becomes `automatic_tax: { enabled: true }`
    // and this block goes away.
    if (order.taxMinor > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency,
          unit_amount: order.taxMinor,
          product_data: { name: `VAT (${Number(order.taxRatePercent)}%)` },
        },
      });
    }

    return stripe().checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      // Lets Stripe write the collected shipping address back onto the
      // customer, so a returning buyer is not retyping it every time.
      customer_update: { shipping: 'auto' },
      line_items: lineItems,
      // Locked to the country the order was priced against. The buyer can
      // correct any part of their address except the one that would invalidate
      // the shipping and tax we already quoted.
      shipping_address_collection: {
        allowed_countries: [
          order.shippingCountryCode as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry,
        ],
      },
      ...(order.shippingMinor > 0 && {
        shipping_options: [
          {
            shipping_rate_data: {
              type: 'fixed_amount' as const,
              fixed_amount: { amount: order.shippingMinor, currency },
              display_name: 'Delivery',
            },
          },
        ],
      }),
      client_reference_id: String(order.id),
      // `kind` is what lets the shared webhook tell an order apart from a
      // subscription without inspecting line items.
      metadata: { kind: 'order', orderId: String(order.id), userId: String(userId) },
      success_url: withQueryParam(config.commerce.orderSuccessUrl, 'orderId', String(order.id)),
      cancel_url: withQueryParam(config.commerce.orderCancelUrl, 'orderId', String(order.id)),
    });
  },

  /**
   * Brings a cart back in line with reality after a failed checkout: drops what
   * cannot be bought, re-captures prices, and trims quantities to available
   * stock.
   *
   * Done *before* the 409 is thrown so that the user, having read what changed,
   * can simply press the button again.
   */
  async repairCart(
    cartId: number,
    items: { bookId: number; quantity: number }[],
    buyable: Map<number, { isbn13: string; unitPriceGbpPence: number; stockQty: number }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      for (const item of items) {
        const live = buyable.get(item.bookId);

        if (!live) {
          await tx
            .delete(cartItems)
            .where(and(eq(cartItems.cartId, cartId), eq(cartItems.bookId, item.bookId)));
          continue;
        }

        await tx
          .update(cartItems)
          .set({
            unitPriceGbpPence: live.unitPriceGbpPence,
            priceCapturedAt: new Date(),
            quantity: Math.max(1, Math.min(item.quantity, live.stockQty)),
            updatedAt: new Date(),
          })
          .where(and(eq(cartItems.cartId, cartId), eq(cartItems.bookId, item.bookId)));
      }
    });
  },
};
