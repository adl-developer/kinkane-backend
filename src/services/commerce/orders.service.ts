/**
 * Reading orders back — the customer's own order history and detail view, plus
 * the state transitions the Stripe webhook drives.
 */
import { and, desc, eq, lt, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  orders,
  orderItems,
  carts,
  type Order,
  type OrderItem,
  type OrderStatus,
} from '../../db/schema';
import { adminNotificationsService } from '../admin/notifications.service';
import { formatMinor } from '../../lib/money';
import { logger } from '../../lib/logger';
import { hashToken, normalizeTrackingCode, tokensMatch } from '../../lib/order-identity';
import { interactionsService } from '../interactions.service';

export interface OrderView {
  id: number;
  /** Customer-facing identity, e.g. `ORD-7K2M9QX4`. */
  reference: string;
  /** The short code for "Track My Order", e.g. `7K2M9QX4`. Ours, not the carrier's. */
  trackingCode: string;
  status: OrderStatus;
  /** The status collapsed for the order UI's filter tabs. */
  statusBucket: 'pending' | 'in_progress' | 'delivered' | 'closed';
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  currency: string;
  subtotalMinor: number;
  /** Promotional reduction applied at checkout; 0 when there was none. */
  discountMinor: number;
  /** Why, e.g. `first_order`. Null when there was no discount. */
  discountReason: string | null;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  itemCount: number;
  placedAt: Date;
  paidAt: Date | null;
  shippingCountryCode: string;
  /** The delivery contact this order was placed with. E.164, or null. */
  contactPhone: string | null;
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

/**
 * The ten `order_status` values collapsed into the three buckets the order UI
 * actually offers (All / In Progress / Delivered, plus a closed bucket for
 * anything that ended badly).
 *
 * Kept as an explicit map rather than a range check so that adding a status to
 * the enum is a compile error here — the alternative is a new status silently
 * defaulting into "in progress" and a refunded order sitting in a customer's
 * active list.
 */
export const ORDER_STATUS_BUCKET = {
  pending_payment: 'pending',
  payment_failed: 'closed',
  expired: 'closed',
  paid: 'in_progress',
  submitted_to_supplier: 'in_progress',
  acknowledged: 'in_progress',
  supplier_rejected: 'closed',
  dispatched: 'in_progress',
  delivered: 'delivered',
  refunded: 'closed',
  cancelled: 'closed',
} as const satisfies Record<Order['status'], 'pending' | 'in_progress' | 'delivered' | 'closed'>;

export type OrderStatusBucket = (typeof ORDER_STATUS_BUCKET)[keyof typeof ORDER_STATUS_BUCKET];

/** Which raw statuses belong to a bucket — the inverse of the map above. */
export function statusesInBucket(bucket: OrderStatusBucket): Order['status'][] {
  return (Object.keys(ORDER_STATUS_BUCKET) as Order['status'][]).filter(
    (status) => ORDER_STATUS_BUCKET[status] === bucket,
  );
}

function toView(order: Order, items?: OrderItem[]): OrderView {
  return {
    id: order.id,
    reference: order.reference,
    trackingCode: order.trackingCode,
    status: order.status,
    statusBucket: ORDER_STATUS_BUCKET[order.status],
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    dispatchedAt: order.dispatchedAt,
    deliveredAt: order.deliveredAt,
    currency: order.presentmentCurrency,
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    discountReason: order.discountReason,
    shippingMinor: order.shippingMinor,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    itemCount: items?.reduce((sum, item) => sum + item.quantity, 0) ?? 0,
    placedAt: order.createdAt,
    paidAt: order.paidAt,
    shippingCountryCode: order.shippingCountryCode,
    contactPhone: order.contactPhone,
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

/**
 * Maps Stripe's optional address fields onto column updates, dropping anything
 * absent so a partial (or entirely empty) collection cannot erase stored data.
 */
function definedShipping(shipping: {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postcode?: string | null;
}): Record<string, string> {
  const columns: Record<string, string | null | undefined> = {
    shippingName: shipping.name,
    shippingLine1: shipping.line1,
    shippingLine2: shipping.line2,
    shippingCity: shipping.city,
    shippingRegion: shipping.region,
    shippingPostcode: shipping.postcode,
  };
  const patch: Record<string, string> = {};
  for (const [column, value] of Object.entries(columns)) {
    if (typeof value === 'string' && value.length > 0) patch[column] = value;
  }
  return patch;
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
  async list(
    userId: number,
    limit: number,
    offset: number,
    bucket?: OrderStatusBucket,
  ): Promise<OrderView[]> {
    // Everything a customer would recognise as an order. 'pending_payment',
    // 'payment_failed' and 'expired' are deliberately absent: an abandoned
    // checkout is not an order, and listing one reads as a billing error.
    const listable: Order['status'][] = [
      'paid',
      'submitted_to_supplier',
      'acknowledged',
      'dispatched',
      'delivered',
      'supplier_rejected',
      'refunded',
      'cancelled',
    ];

    // A requested bucket narrows the listable set; it never widens it, so
    // ?status=pending cannot surface incomplete checkouts.
    const statuses = bucket
      ? listable.filter((status) => ORDER_STATUS_BUCKET[status] === bucket)
      : listable;

    if (statuses.length === 0) return [];

    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.userId, userId), inArray(orders.status, statuses)))
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

  /**
   * An order fetched by its reference and the bearer token issued at checkout.
   *
   * This is the only way to read an order without an account, and it is what
   * "Track My Order" runs on. Both halves are required: the reference is
   * quotable (it is printed on receipts and pasted into support tickets), so it
   * is an identifier, not a credential — the token is the credential.
   *
   * A wrong token and an unknown reference return the same `null`, so the
   * endpoint cannot be used to test whether a reference exists.
   */
  async findByReferenceAndToken(reference: string, token: string): Promise<OrderView | null> {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.reference, reference.toUpperCase()))
      .limit(1);

    if (!order?.guestAccessTokenHash) return null;
    if (!tokensMatch(order.guestAccessTokenHash, hashToken(token))) return null;

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    return toView(order, items);
  },

  /**
   * An order fetched by its short tracking code and the email it was placed
   * with. This is what the "Track My Order" form runs on, for guests and
   * signed-in customers alike.
   *
   * **Both halves are required, and neither is a credential on its own.** The
   * code is eight characters — quotable, printable, and small enough that a
   * patient attacker could walk the space — so the contact email is what makes
   * a guessed code worthless. That is also why the email is compared here in
   * application code rather than being part of the SQL predicate: the query
   * finds one row by its unique code, and the comparison decides whether the
   * caller may see it.
   *
   * `contactEmail` is compared case-insensitively, **not** via
   * `normalizeEmailForPromotions`. That normaliser deliberately collapses
   * `+tags` and gmail dots so two addresses can be the same person for a
   * discount — exactly the property that must not exist here, where a
   * near-miss address would open somebody else's order.
   *
   * A wrong email and an unknown code return the same `null`, so this cannot be
   * used to test which codes exist.
   */
  async findByTrackingCodeAndEmail(code: string, email: string): Promise<OrderView | null> {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.trackingCode, normalizeTrackingCode(code)))
      .limit(1);

    if (!order) return null;
    if (order.contactEmail.trim().toLowerCase() !== email.trim().toLowerCase()) return null;

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    return toView(order, items);
  },

  /**
   * Attaches a guest order to an account.
   *
   * The whole check is one conditional UPDATE rather than a read-then-write.
   * That matters: two tabs submitting the same claim, or an attacker racing a
   * legitimate one, would both pass a separate "is it unclaimed?" read and the
   * second write would silently retag an order that already had an owner. Here
   * the second statement matches zero rows and is rejected.
   *
   * `user_id IS NULL` in the predicate is what makes claiming single-use at the
   * row level, and clearing the token hash retires the credential — a link
   * forwarded from an order confirmation email cannot re-home somebody else's
   * order afterwards.
   */
  async claim(reference: string, token: string, userId: number): Promise<OrderView | null> {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.reference, reference.toUpperCase()))
      .limit(1);

    if (!order?.guestAccessTokenHash) return null;
    if (!tokensMatch(order.guestAccessTokenHash, hashToken(token))) return null;

    const [claimed] = await db
      .update(orders)
      .set({ userId, guestAccessTokenHash: null, updatedAt: new Date() })
      .where(
        and(
          eq(orders.id, order.id),
          isNull(orders.userId),
          eq(orders.guestAccessTokenHash, order.guestAccessTokenHash),
        ),
      )
      .returning();

    if (!claimed) return null;

    logger.info('Guest order claimed', { orderId: claimed.id, userId });

    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, claimed.id));
    return toView(claimed, items);
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

    // The claim itself. `status = 'pending_payment'` in the WHERE clause is what
    // makes this safe: one statement, so Postgres serialises concurrent
    // attempts and exactly one of them updates a row. The read above is a fast
    // path that skips the work for an obvious duplicate; **this** is the check
    // that actually holds.
    //
    // It has to be atomic because Stripe delivers at-least-once and two
    // deliveries can land at the same moment. With a read-then-write both would
    // see `pending_payment`, both would return true, and the caller would run
    // fulfilment twice — which at the far end means shipping and paying for the
    // same books twice.
    const claimed = await db
      .update(orders)
      .set({
        status: 'paid',
        paidAt: new Date(),
        stripePaymentIntentId: details.paymentIntentId,
        // Only overwrite what Stripe actually returned.
        //
        // Orders placed through our own checkout form already carry a full
        // address, written before the payment ever started, and Stripe is not
        // asked to collect one for them. Blanket-assigning `?? null` here — as
        // this did — would wipe that address the moment the webhook landed,
        // leaving a paid order with nowhere to ship to and no way to
        // reconstruct it. Absent means "Stripe had nothing to say", not
        // "the buyer has no address".
        ...definedShipping(details.shipping),
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
      .returning({ id: orders.id });

    if (claimed.length === 0) {
      // Another delivery won the race between our read and this write.
      logger.info('Concurrent delivery already marked this order paid — ignoring', { orderId });
      return false;
    }

    // Tell the console. Never blocks or fails the webhook — a missing bell
    // entry must not turn a successful payment into a retried webhook.
    void adminNotificationsService.emit({
      type: 'order_received',
      title: 'New order received',
      body: `${order.reference} — ${formatMinor(order.totalMinor, order.presentmentCurrency)} from ${order.contactEmail}.`,
      orderId,
      userId: order.userId ?? undefined,
    });

    return true;
  },

  /** Closes the cart this order came from, once payment has landed. */
  /**
   * Marks the cart this order came from as converted.
   *
   * Keyed on the cart id recorded at checkout rather than on the buyer. Two
   * reasons: a guest cart has no user to look it up by at all, and even for a
   * signed-in buyer "their active cart" is not necessarily the one that was
   * paid for — someone who starts a new basket while a payment is pending
   * would otherwise have the *new* cart silently converted and emptied.
   *
   * Still idempotent (the status predicate makes a redelivery a no-op), which
   * the webhook depends on.
   */
  async convertCart(cartId: number | null): Promise<void> {
    if (cartId === null) return;
    await db
      .update(carts)
      .set({ status: 'converted', updatedAt: new Date() })
      .where(and(eq(carts.id, cartId), eq(carts.status, 'active')));
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
