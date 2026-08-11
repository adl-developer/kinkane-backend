/**
 * Reading orders back — the customer's own order history and detail view, plus
 * the state transitions the Stripe webhook drives.
 */
import { and, desc, eq, lt, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  orders,
  orderItems,
  carts,
  type Order,
  type OrderItem,
  type OrderStatus,
} from '../../db/schema';
import { logger } from '../../lib/logger';
import { interactionsService } from '../interactions.service';

export interface OrderView {
  id: number;
  status: OrderStatus;
  currency: string;
  subtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  itemCount: number;
  placedAt: Date;
  paidAt: Date | null;
  shippingCountryCode: string;
  items?: {
    bookId: number;
    isbn13: string;
    title: string;
    contributor: string | null;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }[];
}

function toView(order: Order, items?: OrderItem[]): OrderView {
  return {
    id: order.id,
    status: order.status,
    currency: order.presentmentCurrency,
    subtotalMinor: order.subtotalMinor,
    shippingMinor: order.shippingMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    itemCount: items?.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    placedAt: order.createdAt,
    paidAt: order.paidAt,
    shippingCountryCode: order.shippingCountryCode,
    ...(items && {
      items: items.map((item) => ({
        bookId: item.bookId,
        isbn13: item.isbn13,
        title: item.titleSnapshot,
        contributor: item.contributorSnapshot,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: item.lineTotalMinor,
      })),
    }),
  };
}

export const ordersService = {
  /**
   * The user's order history.
   *
   * Excludes orders that never got past the Stripe redirect: an abandoned
   * checkout is not something a customer thinks of as an order, and showing a
   * list peppered with `pending_payment` rows they never completed reads as a
   * billing error.
   */
  async list(userId: number, limit: number, offset: number): Promise<OrderView[]> {
    const rows = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          inArray(orders.status, [
            'paid',
            'submitted_to_supplier',
            'acknowledged',
            'dispatched',
            'supplier_rejected',
            'refunded',
            'cancelled',
          ]),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) return [];

    const items = await db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, rows.map((row) => row.id)));

    const byOrder = new Map<number, OrderItem[]>();
    for (const item of items) {
      const list = byOrder.get(item.orderId) ?? [];
      list.push(item);
      byOrder.set(item.orderId, list);
    }

    return rows.map((row) => toView(row, byOrder.get(row.id) ?? []));
  },

  /** One order, scoped to its owner — never resolvable by id alone. */
  async get(userId: number, orderId: number): Promise<OrderView | null> {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
      .limit(1);

    if (!order) return null;

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    return toView(order, items);
  },

  async findByStripeSessionId(sessionId: string): Promise<Order | null> {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.stripeCheckoutSessionId, sessionId))
      .limit(1);
    return order ?? null;
  },

  /**
   * The conversion moment: Stripe says the money is ours.
   *
   * Returns false if the order was already paid, so the caller can skip the
   * work that must happen exactly once (fulfilment, interaction signals).
   * Stripe delivers at-least-once and this is the write that spends money at
   * the far end.
   */
  async markPaid(
    orderId: number,
    details: {
      paymentIntentId: string | null;
      shipping: {
        name?: string | null;
        line1?: string | null;
        line2?: string | null;
        city?: string | null;
        region?: string | null;
        postcode?: string | null;
        countryCode?: string | null;
      };
    },
  ): Promise<boolean> {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return false;

    if (order.status !== 'pending_payment') {
      logger.info('Order is already past pending_payment — ignoring duplicate', {
        orderId,
        status: order.status,
      });
      return false;
    }

    // Stripe's address collection was locked to the country the order was
    // priced against, so a mismatch here should be impossible. If it ever
    // happens, the shipping and tax on this order were calculated for somewhere
    // else — record it and let an operator decide, rather than quietly shipping
    // to an address we never quoted.
    const collectedCountry = details.shipping.countryCode?.toUpperCase();
    if (collectedCountry && collectedCountry !== order.shippingCountryCode.toUpperCase()) {
      logger.error('Collected shipping country does not match the quoted destination', {
        orderId,
        quoted: order.shippingCountryCode,
        collected: collectedCountry,
      });
    }

    await db
      .update(orders)
      .set({
        status: 'paid',
        paidAt: new Date(),
        stripePaymentIntentId: details.paymentIntentId,
        shippingName: details.shipping.name ?? null,
        shippingLine1: details.shipping.line1 ?? null,
        shippingLine2: details.shipping.line2 ?? null,
        shippingCity: details.shipping.city ?? null,
        shippingRegion: details.shipping.region ?? null,
        shippingPostcode: details.shipping.postcode ?? null,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    return true;
  },

  /** Closes the cart this order came from, once payment has landed. */
  async convertCart(userId: number): Promise<void> {
    await db
      .update(carts)
      .set({ status: 'converted', updatedAt: new Date() })
      .where(and(eq(carts.userId, userId), eq(carts.status, 'active')));
  },

  /**
   * Records a `purchase` interaction per line.
   *
   * The strongest signal in the system (weight 6) and, until now, the one
   * nothing ever wrote. Fire-and-forget: a Redis hiccup must not fail a
   * webhook that Stripe would then redeliver.
   */
  async recordPurchaseSignals(userId: number, orderId: number): Promise<void> {
    const items = await db
      .select({ bookId: orderItems.bookId })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    for (const item of items) {
      interactionsService.recordFireAndForget(userId, item.bookId, 'purchase');
    }
  },

  async setStatus(orderId: number, status: OrderStatus): Promise<void> {
    await db
      .update(orders)
      .set({ status, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
  },

  /**
   * Expires abandoned checkouts.
   *
   * Stripe sends `checkout.session.expired`, but only for sessions that reach
   * their expiry — a session that errored before the buyer ever saw it produces
   * no event at all, leaving a `pending_payment` row forever. This sweep is the
   * backstop.
   */
  async expireStale(olderThanHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

    const expired = await db
      .update(orders)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(orders.status, 'pending_payment'), lt(orders.createdAt, cutoff)))
      .returning({ id: orders.id });

    if (expired.length > 0) {
      logger.info('Expired abandoned checkouts', { count: expired.length });
    }

    return expired.length;
  },
};
