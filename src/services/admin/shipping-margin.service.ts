/**
 * What we charged for postage against what it cost us.
 *
 * The question this answers is the one that started the whole rate-table
 * exercise: are we selling delivery below cost, and where. Nothing else in the
 * system joins those two numbers — what we charge is decided at checkout and
 * stored on the order, what we pay arrives weeks later on a separate Gardners
 * invoice — which is how a £21-per-order loss to Ghana stayed invisible.
 *
 * It recomputes each order's cost from the rate table rather than from a real
 * invoice, so it is a check on our own pricing, not a reconciliation against
 * what Gardners actually billed. Once invoices are ingested, comparing those to
 * `shipping_gbp_pence` is the stronger version of this.
 */
import { and, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { orders, orderItems } from '../../db/schema';
import { quoteShippingCost } from '../commerce/pricing';
import { shippingRatesService } from '../commerce/shipping-rates.service';

export interface ShippingMarginOrder {
  reference: string;
  countryCode: string;
  serviceCode: string;
  weightG: number;
  /** True when the weight was assumed rather than recorded on the book. */
  weightEstimated: boolean;
  chargedGbpPence: number;
  costGbpPence: number;
  /** Charged minus cost. Negative means we paid to ship it. */
  marginGbpPence: number;
  paidAt: Date | null;
}

export interface ShippingMarginReport {
  days: number;
  /** Every paid order in the window, whether or not it could be compared. */
  totalOrders: number;
  comparableOrders: number;
  /**
   * Orders priced before delivery options existed, or whose destination has
   * since lost its rate. They carry no service code or weight, so there is
   * nothing to recompute from — counted rather than guessed at.
   */
  skippedOrders: number;
  totalChargedGbpPence: number;
  totalCostGbpPence: number;
  totalMarginGbpPence: number;
  /** Margin as a percentage of what we charged. Null when we charged nothing. */
  marginPercent: number | null;
  /** Orders shipping below cost, worst first, capped at `limit`. */
  underwater: ShippingMarginOrder[];
  underwaterCount: number;
  /** How many orders in the window were priced from an assumed book weight. */
  estimatedWeightCount: number;
  /**
   * Caveats an operator needs to read the figures correctly, rather than
   * findings. Returned rather than logged so the console can show them.
   */
  caveats: string[];
}

export const adminShippingMarginService = {
  async report(options: { days: number; limit: number }): Promise<ShippingMarginReport> {
    const since = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        id: orders.id,
        reference: orders.reference,
        countryCode: orders.shippingCountryCode,
        serviceCode: orders.shippingServiceCode,
        weightG: orders.shippingWeightG,
        weightEstimated: orders.shippingWeightEstimated,
        chargedGbpPence: orders.shippingGbpPence,
        paidAt: orders.paidAt,
      })
      .from(orders)
      .where(and(isNotNull(orders.paidAt), gte(orders.paidAt, since)))
      .orderBy(orders.paidAt);

    const empty: ShippingMarginReport = {
      days: options.days,
      totalOrders: rows.length,
      comparableOrders: 0,
      skippedOrders: rows.length,
      totalChargedGbpPence: 0,
      totalCostGbpPence: 0,
      totalMarginGbpPence: 0,
      marginPercent: null,
      underwater: [],
      underwaterCount: 0,
      estimatedWeightCount: rows.filter((row) => row.weightEstimated).length,
      caveats: [],
    };

    if (rows.length === 0) return empty;

    // Item counts in one grouped query rather than a correlated subquery.
    // Drizzle renders an outer column reference inside a raw `sql` subquery
    // unqualified — `WHERE order_id = "id"` — which binds to the *inner*
    // table's own id and silently sums the wrong rows. A join is both correct
    // and easier to read than the escaping that would fix it.
    const countRows = await db
      .select({
        orderId: orderItems.orderId,
        quantity: sql<number>`COALESCE(SUM(${orderItems.quantity}), 0)`.as('quantity'),
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, rows.map((row) => row.id)))
      .groupBy(orderItems.orderId);

    const itemCounts = new Map(countRows.map((row) => [row.orderId, Number(row.quantity)]));

    const rateCard = await shippingRatesService.load();

    const compared: ShippingMarginOrder[] = [];
    let skipped = 0;

    for (const row of rows) {
      if (!row.serviceCode || row.weightG === null) {
        skipped += 1;
        continue;
      }

      let costGbpPence: number;
      try {
        costGbpPence = quoteShippingCost({
          countryCode: row.countryCode,
          serviceCode: row.serviceCode,
          // An order with no line rows still despatched something, so the fee
          // for a single item is the floor rather than zero.
          itemCount: itemCounts.get(row.id) || 1,
          // The recorded despatch weight, replayed. The books may have gained a
          // weight since the order, and the question is what *that* parcel cost.
          //
          // The order does not record whether it went as a large letter, so
          // every parcel is costed at the dearer parcel rate. That only affects
          // the UK, where it overstates cost by around 30p on an order that did
          // go as a large letter — erring towards flagging an order as
          // underwater rather than missing one.
          parcel: {
            weightG: row.weightG,
            estimated: row.weightEstimated,
            fitsLargeLetter: false,
          },
          rateCard,
          at: row.paidAt ?? undefined,
        }).gbpPence;
      } catch {
        // The destination's rates have changed or gone away since.
        skipped += 1;
        continue;
      }

      compared.push({
        reference: row.reference,
        countryCode: row.countryCode,
        serviceCode: row.serviceCode,
        weightG: row.weightG,
        weightEstimated: row.weightEstimated,
        chargedGbpPence: row.chargedGbpPence,
        costGbpPence,
        marginGbpPence: row.chargedGbpPence - costGbpPence,
        paidAt: row.paidAt,
      });
    }

    const totalCharged = compared.reduce((sum, o) => sum + o.chargedGbpPence, 0);
    const totalCost = compared.reduce((sum, o) => sum + o.costGbpPence, 0);
    const underwater = compared
      .filter((order) => order.marginGbpPence < 0)
      .sort((a, b) => a.marginGbpPence - b.marginGbpPence);

    const caveats = [
      'Cost is recomputed from our own rate table, not from a Gardners invoice.',
      'UK orders are costed at the parcel rate — the order does not record whether it went as a large letter — so UK cost is overstated by about 30p on any order that did.',
    ];

    return {
      days: options.days,
      totalOrders: rows.length,
      comparableOrders: compared.length,
      skippedOrders: skipped,
      totalChargedGbpPence: totalCharged,
      totalCostGbpPence: totalCost,
      totalMarginGbpPence: totalCharged - totalCost,
      marginPercent:
        totalCharged > 0
          ? Math.round(((totalCharged - totalCost) / totalCharged) * 1000) / 10
          : null,
      underwater: underwater.slice(0, options.limit),
      underwaterCount: underwater.length,
      estimatedWeightCount: rows.filter((row) => row.weightEstimated).length,
      caveats,
    };
  },
};
