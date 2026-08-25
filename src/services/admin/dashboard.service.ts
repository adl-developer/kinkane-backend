import { and, desc, eq, gte, isNotNull, sql, inArray, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { orders, users, userReports } from '../../db/schema';
import { statusesInBucket } from '../commerce/orders.service';

/**
 * How the admin Orders tabs map onto the eleven order statuses.
 *
 * The design offers three tabs — Processing, Shipped, Delivered — which between
 * them cover only five statuses. The other six need somewhere to go, and the
 * line that decides where is **did money move**:
 *
 * - `unpaid` — nobody was ever charged. A checkout that is still open, one whose
 *   card was declined, one whose session timed out. No sale, nothing owed, and
 *   nothing to chase beyond marketing.
 * - `needs_attention` — money moved and something is wrong. `supplier_rejected`
 *   is the case that matters: the customer has paid and the supplier will not
 *   fulfil, so we owe them a book or a refund.
 *
 * Those two were originally one bucket, which made the badge meaningless: "3
 * need attention" could have been three declined cards (nothing owed) or three
 * paid orders stuck at the supplier (three people waiting for a book they paid
 * for). Same number, opposite urgency.
 *
 * `all` really is all of them, unpaid included.
 */
export const ADMIN_ORDER_TABS = {
  processing: ['paid', 'submitted_to_supplier', 'acknowledged'],
  shipped: ['dispatched'],
  delivered: ['delivered'],
  // Money moved and the order did not land where it should have. `cancelled` is
  // here on the assumption it follows a payment; nothing sets it today, so if
  // something ever cancels an *unpaid* order, move it.
  needs_attention: ['supplier_rejected', 'refunded', 'cancelled'],
  // Never paid for. Deliberately its own tab rather than a count with no way to
  // see it — an operator told "1 unpaid" and given no filter to open it is being
  // shown a dead end.
  unpaid: ['pending_payment', 'payment_failed', 'expired'],
} as const;

export type AdminOrderTab = keyof typeof ADMIN_ORDER_TABS | 'all';

/** Every status that belongs to a tab, as a flat SQL-ready list. */
function statusList(tab: keyof typeof ADMIN_ORDER_TABS): SQL {
  return sql`(${sql.join(ADMIN_ORDER_TABS[tab].map((s) => sql`${s}`), sql`, `)})`;
}

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
          // Derived from ADMIN_ORDER_TABS rather than repeating the status
          // lists as SQL literals. They were duplicated, and a duplicated
          // status list is one someone edits in one place: the card and the tab
          // would then disagree about the same orders.
          processing: sql<number>`count(*) filter (where ${orders.status} in ${statusList('processing')})`,
          needsAttention: sql<number>`count(*) filter (where ${orders.status} in ${statusList('needs_attention')})`,
          unpaid: sql<number>`count(*) filter (where ${orders.status} in ${statusList('unpaid')})`,
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
        // Not a card in the designs — the Orders screen's tab badge reads this.
        unpaid: Number(totals.unpaid),
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

/**
 * Which admin tab a raw status belongs to.
 *
 * Every status in the schema now maps to a real tab, so there is no fallback
 * bucket to hide in — a status added later without a home here falls to
 * `unpaid`, and the test in admin-order-tabs.test.ts fails until someone
 * decides where it actually belongs.
 */
export function tabForStatus(status: string): Exclude<AdminOrderTab, 'all'> {
  for (const [tab, statuses] of Object.entries(ADMIN_ORDER_TABS)) {
    if ((statuses as readonly string[]).includes(status)) {
      return tab as Exclude<AdminOrderTab, 'all'>;
    }
  }
  return 'unpaid';
}

/** Kept so the customer-facing bucket vocabulary stays importable from one place. */
export { statusesInBucket };
