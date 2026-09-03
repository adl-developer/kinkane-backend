/**
 * What we charged for postage against what it cost us, on the terminal.
 *
 *   npx tsx scripts/shipping-margin-report.ts            # last 90 days
 *   npx tsx scripts/shipping-margin-report.ts --days 30
 *   npx tsx scripts/shipping-margin-report.ts --days 365 --limit 40
 *
 * A printer over `adminShippingMarginService`, which is also what
 * `GET /admin/shipping-margin` serves — the console is the way to see this on a
 * deployed environment, where there is no shell to run a script from. The
 * numbers come from one place so the two cannot drift.
 *
 * Read-only.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { adminShippingMarginService } from '../src/services/admin/shipping-margin.service';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const pounds = (pence: number) => `£${(pence / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const report = await adminShippingMarginService.report({
    days: arg('days', 90),
    limit: arg('limit', 20),
  });

  console.log(`\nPaid orders in the last ${report.days} days: ${report.totalOrders}`);
  console.log(`  comparable: ${report.comparableOrders}`);
  console.log(
    `  skipped (priced before delivery options, or rate gone): ${report.skippedOrders}\n`,
  );

  if (report.comparableOrders === 0) {
    console.log('Nothing to compare yet.');
    return;
  }

  console.log(`Charged: ${pounds(report.totalChargedGbpPence)}`);
  console.log(`Cost:    ${pounds(report.totalCostGbpPence)}`);
  console.log(
    `Margin:  ${pounds(report.totalMarginGbpPence)}` +
      (report.marginPercent === null ? '' : ` (${report.marginPercent}% of what we charged)`) +
      '\n',
  );

  if (report.underwaterCount === 0) {
    console.log('No order is shipping below cost.');
  } else {
    console.log(`${report.underwaterCount} order(s) shipping below cost, worst first:\n`);
    for (const order of report.underwater) {
      const label =
        `${order.reference}  ${order.countryCode}  ${order.serviceCode}  ` +
        `${order.weightG}g${order.weightEstimated ? ' (est)' : ''}`;
      console.log(
        `  ${label.padEnd(44)} charged ${pounds(order.chargedGbpPence).padStart(8)}` +
          `  cost ${pounds(order.costGbpPence).padStart(8)}` +
          `  ${pounds(order.marginGbpPence).padStart(9)}`,
      );
    }
    if (report.underwaterCount > report.underwater.length) {
      console.log(`  ... and ${report.underwaterCount - report.underwater.length} more`);
    }
  }

  // The estimated ones are where a quote and an invoice are most likely to
  // disagree, so they are worth calling out even when the margin looks fine.
  if (report.estimatedWeightCount > 0) {
    console.log(
      `\n${report.estimatedWeightCount} order(s) were priced from an assumed book weight — ` +
        'the first thing to check if an invoice disagrees.',
    );
  }

  console.log('');
  for (const caveat of report.caveats) console.log(`Note: ${caveat}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
