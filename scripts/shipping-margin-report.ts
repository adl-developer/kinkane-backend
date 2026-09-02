/**
 * What we charged for postage against what it cost us.
 *
 * The question this answers is the one that started all of this: are we selling
 * delivery below cost, and where. Run it after any rate change, and before
 * deciding what SHIPPING_MARKUP_PERCENT should be.
 *
 *   npx tsx scripts/shipping-margin-report.ts            # last 90 days
 *   npx tsx scripts/shipping-margin-report.ts --days 30
 *   npx tsx scripts/shipping-margin-report.ts --days 365 --limit 40
 *
 * Read-only. It recomputes each order's cost from the rate table rather than
 * from a Gardners invoice, so it is a check on our own pricing, not a
 * reconciliation against what they actually billed. Once invoices are ingested,
 * comparing those to `shipping_gbp_pence` is the stronger version of this.
 *
 * Orders priced before delivery options existed carry no service code or
 * weight, so there is nothing to recompute from; they are counted and skipped
 * rather than guessed at.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { and, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../src/db';
import { orders } from '../src/db/schema';
import { quoteShipping } from '../src/services/commerce/pricing';
import { shippingRatesService } from '../src/services/commerce/shipping-rates.service';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const days = arg('days', 90);
  const limit = arg('limit', 20);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: orders.id,
      reference: orders.reference,
      country: orders.shippingCountryCode,
      serviceCode: orders.shippingServiceCode,
      weightG: orders.shippingWeightG,
      estimated: orders.shippingWeightEstimated,
      chargedGbpPence: orders.shippingGbpPence,
      rule: orders.shippingRule,
      itemCount: sql<number>`(
        SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = ${orders.id}
      )`.as('item_count'),
      paidAt: orders.paidAt,
    })
    .from(orders)
    .where(and(isNotNull(orders.paidAt), gte(orders.paidAt, since)))
    .orderBy(orders.paidAt);

  if (rows.length === 0) {
    console.log(`No paid orders in the last ${days} days.`);
    return;
  }

  const rateCard = await shippingRatesService.load();

  let comparable = 0;
  let skipped = 0;
  let totalCharged = 0;
  let totalCost = 0;
  const losses: { label: string; charged: number; cost: number; margin: number }[] = [];

  for (const row of rows) {
    // Nothing to recompute against for an order priced under the flat table.
    if (!row.serviceCode || row.weightG === null) {
      skipped += 1;
      continue;
    }

    let cost: number;
    try {
      cost = quoteShipping({
        countryCode: row.country,
        serviceCode: row.serviceCode,
        itemCount: Number(row.itemCount) || 1,
        subtotalGbpPence: 0,
        // The recorded despatch weight, replayed. measureParcel is not called
        // here on purpose: the books in the order may have gained a weight
        // since, and the question is what *that* parcel cost.
        //
        // The order does not record whether it went as a large letter, so every
        // parcel is costed at the dearer parcel rate. That only affects the UK,
        // where it overstates cost by around 30p on an order that actually went
        // as a large letter — erring towards flagging an order as underwater
        // rather than missing one, which is the right direction for this report.
        parcel: { weightG: row.weightG, estimated: row.estimated, fitsLargeLetter: false },
        rateCard,
        at: row.paidAt ?? undefined,
      }).gbpPence;
    } catch {
      // Rates for that destination have changed or gone away since.
      skipped += 1;
      continue;
    }

    comparable += 1;
    totalCharged += row.chargedGbpPence;
    totalCost += cost;

    losses.push({
      label: `${row.reference}  ${row.country}  ${row.serviceCode}  ${row.weightG}g${row.estimated ? ' (est)' : ''}`,
      charged: row.chargedGbpPence,
      cost,
      margin: row.chargedGbpPence - cost,
    });
  }

  console.log(`\nPaid orders in the last ${days} days: ${rows.length}`);
  console.log(`  comparable: ${comparable}`);
  console.log(`  skipped (priced before delivery options, or rate gone): ${skipped}\n`);

  if (comparable === 0) {
    console.log('Nothing to compare yet.');
    return;
  }

  const margin = totalCharged - totalCost;
  console.log(`Charged: ${pounds(totalCharged)}`);
  console.log(`Cost:    ${pounds(totalCost)}`);
  console.log(
    `Margin:  ${pounds(margin)} (${((margin / totalCharged) * 100).toFixed(1)}% of what we charged)\n`,
  );

  console.log(
    'UK orders are costed at the parcel rate, since the order does not record\n' +
      'whether it went as a large letter — so UK cost is overstated by ~30p on\n' +
      'any order that did.\n',
  );

  const underwater = losses.filter((entry) => entry.margin < 0);
  if (underwater.length === 0) {
    console.log('No order is shipping below cost.');
  } else {
    console.log(`${underwater.length} order(s) shipping below cost, worst first:\n`);
    underwater
      .sort((a, b) => a.margin - b.margin)
      .slice(0, limit)
      .forEach((entry) => {
        console.log(
          `  ${entry.label.padEnd(44)} charged ${pounds(entry.charged).padStart(8)}` +
            `  cost ${pounds(entry.cost).padStart(8)}  ${pounds(entry.margin).padStart(9)}`,
        );
      });
  }

  // The estimated ones are where a quote and an invoice are most likely to
  // disagree, so they are worth calling out even when the margin looks fine.
  const estimatedCount = rows.filter((row) => row.estimated).length;
  if (estimatedCount > 0) {
    console.log(
      `\n${estimatedCount} order(s) were priced from an assumed book weight — the ` +
        'first thing to check if an invoice disagrees.',
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
