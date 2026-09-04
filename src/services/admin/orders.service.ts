import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { orders, orderItems, users } from '../../db/schema';
import { ADMIN_ORDER_TABS, orderCustomerName, tabForStatus, type AdminOrderTab } from './dashboard.service';

export interface AdminOrderQuery {
  tab: AdminOrderTab;
  q?: string;
  limit: number;
  offset: number;
}

function whereFor(query: AdminOrderQuery): SQL | undefined {
  const conditions: SQL[] = [];

  if (query.tab !== 'all') {
    conditions.push(inArray(orders.status, [...ADMIN_ORDER_TABS[query.tab]]));
  }

  if (query.q) {
    const like = `%${query.q}%`;
    // Reference, contact email, and the name on the parcel. An operator
    // searching here has one of those three in front of them — usually pasted
    // out of an email from the customer.
    conditions.push(
      or(
        ilike(orders.reference, like),
        ilike(orders.contactEmail, like),
        ilike(orders.shippingName, like),
      )!,
    );
  }

  return conditions.length ? and(...conditions) : undefined;
}

export const adminOrdersService = {
  /**
   * The Orders table, and the counts on its tabs.
   *
   * Counts come back for every tab on every request, not just the selected one:
   * the design puts a number on each, and one grouped scan is cheaper than five
   * separate count queries.
   */
  async list(query: AdminOrderQuery) {
    const where = whereFor(query);

    const [rows, [total], byStatus] = await Promise.all([
      db
        .select({
          id: orders.id,
          reference: orders.reference,
          status: orders.status,
          currency: orders.presentmentCurrency,
          subtotalMinor: orders.subtotalMinor,
          discountMinor: orders.discountMinor,
          shippingMinor: orders.shippingMinor,
          taxMinor: orders.taxMinor,
          totalMinor: orders.totalMinor,
          placedAt: orders.createdAt,
          paidAt: orders.paidAt,
          contactEmail: orders.contactEmail,
          contactPhone: orders.contactPhone,
          customerId: orders.userId,
          customerName: orderCustomerName,
          shippingName: orders.shippingName,
          shippingLine1: orders.shippingLine1,
          shippingLine2: orders.shippingLine2,
          shippingCity: orders.shippingCity,
          shippingPostcode: orders.shippingPostcode,
          shippingCountryCode: orders.shippingCountryCode,
          itemCount: sql<number>`(select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${orders.id})`,
          fulfilmentError: orders.fulfilmentErrorMessage,
        })
        .from(orders)
        .leftJoin(users, eq(users.id, orders.userId))
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ n: sql<number>`count(*)` }).from(orders).where(where),
      db
        .select({ status: orders.status, n: sql<number>`count(*)` })
        .from(orders)
        .groupBy(orders.status),
    ]);

    const counts: Record<string, number> = {
      all: 0, processing: 0, shipped: 0, delivered: 0, needs_attention: 0, unpaid: 0,
    };
    for (const row of byStatus) {
      counts.all += Number(row.n);
      counts[tabForStatus(row.status)] += Number(row.n);
    }

    return {
      orders: rows.map((r) => ({ ...r, itemCount: Number(r.itemCount), tab: tabForStatus(r.status) })),
      total: Number(total.n),
      counts,
    };
  },

  /**
   * The expanded row: line items for a page of orders, fetched in one query.
   *
   * The design expands a row in place rather than opening a detail page, so the
   * client can ask for the items of everything it is showing and expand without
   * a round trip. Bounded by the page size the caller already applied.
   */
  async itemsFor(orderIds: number[]) {
    if (orderIds.length === 0) return new Map<number, unknown[]>();

    const rows = await db
      .select({
        orderId: orderItems.orderId,
        bookId: orderItems.bookId,
        isbn13: orderItems.isbn13,
        title: orderItems.titleSnapshot,
        contributor: orderItems.contributorSnapshot,
        quantity: orderItems.quantity,
        unitPriceMinor: orderItems.unitPriceMinor,
        lineTotalMinor: orderItems.lineTotalMinor,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds));

    const byOrder = new Map<number, unknown[]>();
    for (const row of rows) {
      const { orderId, ...item } = row;
      if (!byOrder.has(orderId)) byOrder.set(orderId, []);
      byOrder.get(orderId)!.push(item);
    }
    return byOrder;
  },
};
