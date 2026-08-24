import { and, desc, eq, gte, isNotNull, sql, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { orders, users, userReports } from '../../db/schema';
import { statusesInBucket } from '../commerce/orders.service';

/**
 * How the admin Orders tabs map onto the eleven order statuses.
 *
 * The design offers three tabs. The statuses that fit none of them —
 * `payment_failed`, `expired`, `supplier_rejected`, `refunded`, `cancelled` —
 * are collected under `needs_attention` rather than being dropped, because
 * `supplier_rejected` is precisely the order an operator has to find: a
 * customer has paid and the supplier will not fulfil it. Leaving it out of
 * every tab would make it invisible in the only screen anyone looks at.
 *
 * `all` really is all of them, including the ones nobody has paid for yet.
 */
export const ADMIN_ORDER_TABS = {
  processing: ['paid', 'submitted_to_supplier', 'acknowledged'],
  shipped: ['dispatched'],
  delivered: ['delivered'],
  needs_attention: ['payment_failed', 'supplier_rejected', 'refunded', 'cancelled'],
} as const;

export type AdminOrderTab = keyof typeof ADMIN_ORDER_TABS | 'all';

/** "Active" for the customer counts: has paid for something in the last year. */
export const ACTIVE_CUSTOMER_WINDOW_DAYS = 365;

function windowStart(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export const adminDashboardService = {
  /**
   * The Overview cards plus the Recent Orders table.
   *
   * Everything here counts **paid** orders only — cards and table alike. They
   * have to agree: a total that excludes abandoned checkouts sitting above a
   * table that includes them is a dashboard arguing with itself.
   *
   * Every figure is "all time" as the design labels it, except the active
   * customer count. Live aggregates are fine at present volumes; if `orders`
   * grows past a few hundred thousand this wants a nightly rollup, because
   * "all time" only ever gets slower.
   */
  async overview(recentLimit = 10) {
    const paidStatuses = [
      ...ADMIN_ORDER_TABS.processing,
      ...ADMIN_ORDER_TABS.shipped,
      ...ADMIN_ORDER_TABS.delivered,
    ];

    const [[totals], [customerCounts], [activeCount], recent] = await Promise.all([
      db
        .select({
          // Counts only orders somebody actually paid for. An abandoned Stripe
          // redirect is not a sale and must not appear in a revenue figure.
          totalOrders: sql<number>`count(*) filter (where ${orders.paidAt} is not null)`,
          revenueMinor: sql<number>`coalesce(sum(${orders.totalMinor}) filter (where ${orders.paidAt} is not null), 0)`,
          // The fulfilment queue: paid, not yet dispatched.
          processing: sql<number>`count(*) filter (where ${orders.status} in ('paid','submitted_to_supplier','acknowledged'))`,
          needsAttention: sql<number>`count(*) filter (where ${orders.status} in ('payment_failed','supplier_rejected','refunded','cancelled'))`,
        })
        .from(orders),
      db.select({ total: sql<number>`count(*)` }).from(users),
      db
        .select({ active: sql<number>`count(distinct ${orders.userId})` })
        .from(orders)
        .where(and(isNotNull(orders.paidAt), gte(orders.paidAt, windowStart(ACTIVE_CUSTOMER_WINDOW_DAYS)))),
      db
        .select({
          id: orders.id,
          reference: orders.reference,
          customerName: sql<string | null>`coalesce(${users.name}, ${orders.shippingName})`,
          contactEmail: orders.contactEmail,
          status: orders.status,
          currency: orders.presentmentCurrency,
          totalMinor: orders.totalMinor,
          placedAt: orders.createdAt,
          itemCount: sql<number>`(select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${orders.id})`,
        })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.userId))
        // Paid orders only, matching the cards above the table and the rule the
        // customer-facing list already follows: an abandoned checkout is not an
        // order. Without this the dashboard reads "TOTAL ORDERS 0" directly
        // above a table listing two of them, which is how it was first built.
        //
        // Abandoned checkouts are still reachable — they are counted as
        // `pending` on the Orders screen and included in its `all` tab, which is
        // where someone diagnosing a broken checkout would go looking.
        .where(isNotNull(orders.paidAt))
        .orderBy(desc(orders.paidAt))
        .limit(recentLimit),
    ]);

    const totalCustomers = Number(customerCounts.total);
    const active = Number(activeCount.active);

    return {
      totals: {
        orders: Number(totals.totalOrders),
        revenueMinor: Number(totals.revenueMinor),
        // Revenue sums presentment minor units across whatever currencies were
        // charged. Correct only while the shop sells in one; the moment it
        // genuinely sells in several this needs converting to a base currency,
        // and the figure is labelled with one so the ambiguity is visible.
        revenueCurrency: 'USD',
        processing: Number(totals.processing),
        needsAttention: Number(totals.needsAttention),
        customers: totalCustomers,
        activeCustomers: active,
        inactiveCustomers: Math.max(0, totalCustomers - active),
      },
      recentOrders: recent.map((r) => ({
        ...r,
        itemCount: Number(r.itemCount),
        statusTab: tabForStatus(r.status),
      })),
    };
  },

  /** The two sidebar badges: orders awaiting fulfilment, reports awaiting a decision. */
  async badges() {
    const [[orderCount], [reportCount], [unreadCount]] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)` })
        .from(orders)
        .where(inArray(orders.status, [...ADMIN_ORDER_TABS.processing])),
      db
        .select({ n: sql<number>`count(*)` })
        .from(userReports)
        .where(eq(userReports.status, 'pending')),
      db
        .select({ n: sql<number>`count(*)` })
        .from(sql`admin_notifications`)
        .where(sql`read_at is null`),
    ]);

    return {
      orders: Number(orderCount.n),
      reports: Number(reportCount.n),
      unreadNotifications: Number(unreadCount.n),
    };
  },
};

/** Which admin tab a raw status belongs to. Exported for the orders listing. */
export function tabForStatus(status: string): AdminOrderTab | 'pending' {
  for (const [tab, statuses] of Object.entries(ADMIN_ORDER_TABS)) {
    if ((statuses as readonly string[]).includes(status)) return tab as AdminOrderTab;
  }
  // pending_payment and expired: started but never paid for.
  return 'pending';
}

/** Kept so the customer-facing bucket vocabulary stays importable from one place. */
export { statusesInBucket };
