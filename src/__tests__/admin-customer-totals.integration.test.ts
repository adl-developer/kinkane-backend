import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The Customers screen's per-row totals, against a real Postgres.
 *
 * The bug this guards was invisible to everything except a real query: the
 * per-customer subqueries interpolated `users.id`, which Drizzle prints as a
 * bare "id" in a select with no joins, and inside `from orders o` that bound to
 * the order's own id. Every customer read zero orders and zero spend, with no
 * error. The fixture makes sure no order's id equals its customer's id, so the
 * old query cannot pass by coincidence.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users and orders. Skips itself when unset; refuses to run when it names the
 * same database as `.env`. Setup as in nielsen-budget.integration.test.ts.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  const configured = configuredUrl();
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'These tests delete rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let service: typeof import('../services/admin/customers.service').adminCustomersService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'admin-customer-totals-test-';

describeIfDb('admin Customers per-row totals', () => {
  let userId: number;
  const orderIds: number[] = [];

  async function cleanUp(): Promise<void> {
    // Orders restrict deletion of their user, so they go first.
    await db.execute(sql`
      DELETE FROM orders WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'})
    `);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function order(n: number, totalMinor: number, paidAt: string | null): Promise<void> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO orders (
        user_id, reference, tracking_code, status,
        subtotal_gbp_pence, total_gbp_pence, presentment_currency, subtotal_minor, total_minor,
        fx_rate, fx_captured_at, contact_email, contact_email_normalized, shipping_country_code,
        paid_at
      ) VALUES (
        ${userId}, ${`ACT-${userId}-${n}`}, ${`ACT${userId}${n}`.slice(0, 16)},
        ${paidAt ? 'paid' : 'pending_payment'},
        ${totalMinor}, ${totalMinor}, 'GBP', ${totalMinor}, ${totalMinor},
        1, now(), ${`${EMAIL_PREFIX}ama@example.com`}, ${`${EMAIL_PREFIX}ama@example.com`}, 'GB',
        ${paidAt}
      )
      RETURNING id
    `);
    orderIds.push(rows[0].id);
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ adminCustomersService: service } = await import('../services/admin/customers.service'));

    await cleanUp();

    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, email) VALUES ('Ama Owusu', ${`${EMAIL_PREFIX}ama@example.com`}) RETURNING id
    `);
    userId = rows[0].id;

    // Burn order ids until none can collide with the user's own id, so the
    // old "o.user_id = o.id" reading cannot match any of these rows.
    await db.execute(sql`SELECT setval(pg_get_serial_sequence('orders', 'id'), greatest(nextval(pg_get_serial_sequence('orders', 'id')), ${userId} + 1000))`);

    await order(1, 1500, '2026-09-01T10:00:00Z');
    await order(2, 2500, '2026-10-01T10:00:00Z');
    // Never paid: not an order, as far as the screen is concerned.
    await order(3, 9900, null);
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  it('counts the customer\'s own paid orders, spend and last order', async () => {
    expect(orderIds).not.toContain(userId);

    const { customers } = await service.list({ q: EMAIL_PREFIX, limit: 20, offset: 0 });
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: userId, orders: 2, totalSpentMinor: 4000 });
    expect(new Date(customers[0].lastOrderAt as unknown as string).toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });

  it('treats LIKE wildcards in a search as literal characters', async () => {
    // Unescaped, `_` matches the `-` in the fixture email.
    const { total } = await service.list({ q: 'admin_customer_totals', limit: 20, offset: 0 });
    expect(total).toBe(0);
  });
});
