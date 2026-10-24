import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The writes that move money, and the shape that keeps them safe.
 *
 * Every bug these guard against is the same one: read a row, decide something,
 * write it — with a window in between where a second request does the same. At
 * this end of the system that window means charging twice, shipping twice, or
 * giving away a promotion twice, and none of it is visible afterwards without
 * reconciling against Stripe or the supplier.
 *
 * Asserted against the source because the property is structural. Proving it by
 * execution needs real concurrency against a real database, which the live
 * checks in the changelog cover instead.
 */

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `could not find "${signature}"`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('\n  },\n');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('markPaid — the conversion write', () => {
  const body = methodBody(read('services/commerce/orders.service.ts'), 'async markPaid(');

  it('claims the order with a conditional update, not a read-then-write', () => {
    // Stripe delivers at-least-once. Two deliveries landing together must not
    // both return true, because the caller runs fulfilment on a true.
    expect(body).toContain("eq(orders.status, 'pending_payment')");
    expect(body).toContain('.returning(');
  });

  it('reports failure when another delivery won the race', () => {
    expect(body).toContain('claimed.length === 0');
    expect(body).toMatch(/claimed\.length === 0[\s\S]{0,400}return false/);
  });
});

describe('fulfilment.submit — the write that ships books', () => {
  const body = methodBody(read('services/commerce/fulfilment.service.ts'), 'async submit(');

  it('claims the order before talking to the supplier', () => {
    // A duplicate submission means shipping and paying for the same books
    // twice, so the claim has to happen before the external call, not after.
    const claimAt = body.indexOf('.set({ status: \'submitted_to_supplier\'');
    const sendAt = body.indexOf('createAndSubmit');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(sendAt);
  });

  it('claims only an order that is paid and unsubmitted', () => {
    expect(body).toContain("eq(orders.status, 'paid')");
    expect(body).toContain('isNull(orders.gardnersDropshipOrderId)');
  });

  it('releases the claim when the send fails, so a retry can pick it up', () => {
    const katch = body.slice(body.indexOf('} catch'));
    expect(katch).toContain("status: 'paid'");
  });
});

describe('first-order discount', () => {
  const checkout = read('services/commerce/checkout.service.ts');

  it('decides eligibility inside the transaction that writes the order', () => {
    expect(checkout).toContain('hasPaidBefore(normalizedEmail, userId, tx)');
  });

  it('leans on a database constraint, not only on the check', () => {
    // Two checkouts starting at the same instant both legitimately see "no paid
    // order" — no isolation level makes that untrue. Only a write-time
    // constraint stops both being written.
    const schema = read('db/schema/commerce.ts');
    expect(schema).toContain('uq_orders_first_order_discount');
    // Partial, so abandoning a discounted checkout does not burn the promotion.
    expect(schema).toContain("NOT IN ('expired', 'payment_failed', 'cancelled')");
  });

  it('re-prices without the discount rather than failing the checkout', () => {
    expect(checkout).toContain('isUniqueViolation');
    expect(checkout).toContain('quote = priceBasket(0)');
  });
});

describe('multi-write admin actions', () => {
  it('blacklisting blocks the account and ends its sessions in one transaction', () => {
    const body = methodBody(read('services/admin/customers.service.ts'), 'async blacklist(');
    expect(body).toContain('db.transaction');
    expect(body).toContain('refreshTokens');
  });

  it('blacklisting from a report shares one transaction with resolving it', () => {
    const reports = read('services/admin/reports.service.ts');
    expect(reports).toContain('db.transaction');
    // The handle is passed down rather than nested: under postgres-js a nested
    // db.transaction() takes a separate connection, so the two writes would not
    // be atomic and would deadlock on the same users row.
    expect(reports).toContain('`Blacklisted from report ${reportId}`,\n        tx,');
  });
});
