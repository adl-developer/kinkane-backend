/**
 * Manual end-to-end test for the Gardners I12 Home Delivery (dropship)
 * purchase flow: builds an order from BOOKS below, submits it to HOMEORD,
 * then polls HOMEACK until Gardners' .ACK shows up (or the timeout elapses),
 * printing the outcome.
 *
 * Requires GARDNERS_DROPSHIP_SFTP_HOST/USERNAME/PASSWORD and
 * GARDNERS_DROPSHIP_ACCOUNT_CODE to be set (see .env.example). Defaults to
 * GARDNERS_DROPSHIP_DEFAULT_TESTING=true, meaning Gardners acknowledges the
 * order normally but never creates real order lines — safe to run against
 * production credentials.
 *
 * Usage: npx tsx scripts/gardners-dropship-test.ts
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/db';
import { books, gardnersStock } from '../src/db/schema';
import { gardnersDropshipOrderService, type CreateOrderLineInput } from '../src/services/gardners-dropship/order.service';

// Fill in the books to order: ISBN-13 + quantity. Price/title are looked up
// from the DB (gardners_stock.rrp_gbp, falling back to book_prices/RRP=0 with
// a warning) so this doesn't require hand-copying prices.
const BOOKS: { isbn13: string; quantity: number }[] = [
  // { isbn13: '9780711249530', quantity: 1 },
];

// Stand-in recipient for this test — Kinkane's own Accra office, matching
// the precedent set by the two hand-tested orders in EDI_docs/ (43, 44).
// Swap this for a real customer address once wired into checkout.
const TEST_RECIPIENT = {
  name: 'Kinkane',
  addr1: '24 Cantonments Road',
  addr2: 'Cantonments',
  addr3: 'Accra',
  postcode: 'GA',
  country: 'GHANA',
};
const TEST_TRACKING_EMAIL = 'jane.kinkane@gmail.com';
const TEST_TRACKING_SMS = '00233244123456';

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

async function resolveLine(isbn13: string, quantity: number): Promise<CreateOrderLineInput> {
  const [book] = await db.select().from(books).where(eq(books.isbn13, isbn13)).limit(1);
  const [stock] = await db.select().from(gardnersStock).where(eq(gardnersStock.isbn13, isbn13)).limit(1);

  if (!stock) {
    console.warn(`⚠ No gardners_stock row for ${isbn13} — proceeding with PRICE=0 (Gardners will use their own RRP).`);
  }

  const priceGbpPence = stock?.rrpGbp ? Math.round(Number(stock.rrpGbp) * 100) : 0;

  console.log(
    `  ${isbn13}  qty=${quantity}  ${book?.title ?? '(title unknown — not in local catalogue)'}  price=${
      priceGbpPence ? `£${(priceGbpPence / 100).toFixed(2)}` : '(none on file)'
    }`,
  );

  return {
    isbn13,
    quantity,
    priceGbpPence,
    serviceCode: '011', // Overseas Airmail Tracked — matches EDI_docs precedent for Ghana delivery
    tracking: true,
    trackingEmail: TEST_TRACKING_EMAIL,
    trackingSms: TEST_TRACKING_SMS,
    invoice: TEST_RECIPIENT,
    maxWaitDays: 7,
  };
}

async function main() {
  if (BOOKS.length === 0) {
    console.error('BOOKS is empty — add { isbn13, quantity } entries at the top of this script before running.');
    process.exit(1);
  }

  console.log(`Resolving ${BOOKS.length} line(s) from the local catalogue...`);
  const lines = await Promise.all(BOOKS.map((b) => resolveLine(b.isbn13, b.quantity)));

  console.log('\nCreating and submitting order...');
  const { order } = await gardnersDropshipOrderService.createAndSubmit({ lines });
  console.log(
    `Submitted ${order.fileStem}.ORD (order id ${order.id}, testing=${order.testing}) — waiting for Gardners' ACK...`,
  );

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const outcome = await gardnersDropshipOrderService.pollAck(order.id);

    if (outcome.status === 'not_ready') {
      console.log('  ...still waiting');
      continue;
    }

    if (outcome.status === 'header_rejected') {
      console.error(`\n✗ Whole order rejected: ${outcome.message}`);
      process.exit(1);
    }

    console.log(
      `\n✓ Acknowledged — fulfilled=${outcome.fulfilled} backordered=${outcome.backordered} rejected=${outcome.rejected}`,
    );
    const { lines: finalLines } = await gardnersDropshipOrderService.getOrder(order.id);
    for (const line of finalLines) {
      console.log(
        `  ${line.isbn13}  status=${line.status}  gardnersRef=${line.gardnersRef ?? '-'}  qtySupplied=${
          line.quantitySupplied ?? '-'
        }${line.lineErrorMessage ? `  error="${line.lineErrorMessage}"` : ''}`,
      );
    }
    process.exit(0);
  }

  console.error(`\n✗ Timed out after ${POLL_TIMEOUT_MS / 60_000} minutes waiting for Gardners' ACK.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
