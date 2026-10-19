import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Restock requests, end to end against a real Postgres: who may file one, what
 * gets stored, and the admin screen's cards, counts and actions.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * books, users and admins it created. Skips itself when unset; refuses to run
 * when it names the same database as `.env`. Setup as in
 * nielsen-budget.integration.test.ts.
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

// The admin router is mounted for real below; its limiters need Redis and its
// controllers pull in the mail and push queues.
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { adminLoginLimiter: pass, adminPasswordResetLimiter: pass, adminPasswordResetEmailLimiter: pass };
});

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let customer: typeof import('../services/restock-requests.service').restockRequestsService;
let admin: typeof import('../services/admin/restock-requests.service').adminRestockRequestsService;
let badges: typeof import('../services/admin/dashboard.service').adminDashboardService;

const describeIfDb = testUrl ? describe : describe.skip;

// ISBNs no other suite uses (9789999999990 is the contract suite's seed).
const ISBN = {
  outOfStock: '9798888000001',
  outOfStockHardback: '9798888000002',
  inStock: '9798888000003',
  toOrder: '9798888000004',
  noPrice: '9798888000005',
  restrictedGb: '9798888000006',
  outOfPrint: '9798888000007',
  reprinting: '9798888000008',
  inStockRestrictedGb: '9798888000009',
};
const ISBNS = Object.values(ISBN);
const EMAIL_PREFIX = 'restock-test-';
const TITLE_PREFIX = 'RestockTest';

describeIfDb('restock requests', () => {
  const bookIds: Record<keyof typeof ISBN, number> = {} as never;
  let realUserId: number;
  let guestUserId: number;
  let adminId: number;

  async function cleanUp(): Promise<void> {
    await db.execute(sql`DELETE FROM admin_notifications WHERE type = 'restock_requested' AND body LIKE ${'%' + TITLE_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM restock_requests WHERE isbn13 IN (${sql.join(ISBNS.map((i) => sql`${i}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM book_contributors WHERE book_id IN (SELECT id FROM books WHERE isbn13 IN (${sql.join(ISBNS.map((i) => sql`${i}`), sql`, `)}))`);
    await db.execute(sql`DELETE FROM gardners_market_restrictions WHERE isbn13 IN (${sql.join(ISBNS.map((i) => sql`${i}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM gardners_stock WHERE isbn13 IN (${sql.join(ISBNS.map((i) => sql`${i}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM books WHERE isbn13 IN (${sql.join(ISBNS.map((i) => sql`${i}`), sql`, `)})`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM admins WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function book(
    key: keyof typeof ISBN,
    title: string,
    productForm: string,
    stock: { rrp: string | null; qty: number; reportCode?: string },
  ): Promise<void> {
    const isbn = ISBN[key];
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO books (record_reference, isbn13, title, product_form)
      VALUES (${'restock-test-' + isbn}, ${isbn}, ${`${TITLE_PREFIX} ${title}`}, ${productForm})
      RETURNING id
    `);
    bookIds[key] = rows[0].id;
    await db.execute(sql`
      INSERT INTO book_contributors (book_id, person_name, sequence_number)
      VALUES (${rows[0].id}, 'Tommy Orange', 1)
    `);
    await db.execute(sql`
      INSERT INTO gardners_stock (isbn13, source, stock_updated_at, rrp_gbp, stock_qty, report_code)
      VALUES (${isbn}, 'test', now(), ${stock.rrp}, ${stock.qty}, ${stock.reportCode ?? null})
    `);
  }

  function submit(key: keyof typeof ISBN, extra: Partial<Parameters<typeof customer.submit>[0]> = {}) {
    return customer.submit({ bookId: bookIds[key], userId: null, name: null, email: null, country: 'GB', ...extra });
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ restockRequestsService: customer } = await import('../services/restock-requests.service'));
    ({ adminRestockRequestsService: admin } = await import('../services/admin/restock-requests.service'));
    ({ adminDashboardService: badges } = await import('../services/admin/dashboard.service'));

    await cleanUp();

    await book('outOfStock', 'Wandering Stars', 'BC', { rrp: '9.99', qty: 0 });
    await book('outOfStockHardback', 'Wandering Stars', 'BB', { rrp: '19.99', qty: 0 });
    await book('inStock', 'Milk and Honey', 'BC', { rrp: '8.99', qty: 12 });
    await book('toOrder', 'Silver Sparrow', 'BC', { rrp: '9.99', qty: 0, reportCode: 'GXC' });
    await book('noPrice', 'The Sun and Her Flowers', 'BB', { rrp: null, qty: 0 });
    await book('restrictedGb', 'Restricted Title', 'BC', { rrp: '9.99', qty: 0 });
    await book('outOfPrint', 'Out Of Print', 'BC', { rrp: '9.99', qty: 0, reportCode: 'O/P' });
    await book('reprinting', 'Reprinting', 'BC', { rrp: '9.99', qty: 0, reportCode: 'R/P' });
    await book('inStockRestrictedGb', 'Restricted In Stock', 'BC', { rrp: '9.99', qty: 5 });
    // Not to be sold in the UK.
    for (const isbn of [ISBN.restrictedGb, ISBN.inStockRestrictedGb]) {
      await db.execute(sql`
        INSERT INTO gardners_market_restrictions (isbn13, flag, region_code, synced_at)
        VALUES (${isbn}, 'N', 'UKI', now())
      `);
    }

    const users = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, email, is_guest) VALUES
        ('Amara Diallo', ${EMAIL_PREFIX + 'amara@example.com'}, false),
        ('Guest', ${EMAIL_PREFIX + 'guest-1234@guest.kinkane.app'}, true)
      RETURNING id
    `);
    [realUserId, guestUserId] = [users[0].id, users[1].id];

    const admins = await db.execute<{ id: number }>(sql`
      INSERT INTO admins (name, email, password_hash) VALUES ('Ama', ${EMAIL_PREFIX + 'admin@example.com'}, 'x')
      RETURNING id
    `);
    adminId = admins[0].id;
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  describe('who can file one', () => {
    it('accepts an out-of-stock edition and stamps an RR reference', async () => {
      const { reference } = await submit('outOfStock', { name: 'Priya Nair', email: EMAIL_PREFIX + 'priya@books.in' });
      expect(reference).toMatch(/^RR\d{3,}$/);

      const [row] = await db.execute<{ name: string; email: string; status: string; admin_emailed_at: Date | null }>(sql`
        SELECT name, email, status, admin_emailed_at FROM restock_requests WHERE reference = ${reference}
      `);
      expect(row).toMatchObject({ name: 'Priya Nair', email: EMAIL_PREFIX + 'priya@books.in', status: 'pending', admin_emailed_at: null });
    });

    it('rings the admin bell with the title and format', async () => {
      const rows = await db.execute<{ body: string }>(sql`
        SELECT body FROM admin_notifications
        WHERE type = 'restock_requested' AND body LIKE ${'%' + TITLE_PREFIX + ' Wandering Stars (Paperback)%'}
      `);
      expect(rows.length).toBeGreaterThan(0);
      // Never the customer's own text: the endpoint is public.
      expect(rows[0].body).toBe(`A customer asked for ${TITLE_PREFIX} Wandering Stars (Paperback) to be restocked.`);
    });

    it('refuses a book that is in stock', async () => {
      await expect(submit('inStock')).rejects.toMatchObject({ statusCode: 409, code: 'IN_STOCK' });
    });

    it('refuses a supplied-to-order book, which can simply be ordered', async () => {
      await expect(submit('toOrder')).rejects.toMatchObject({ statusCode: 409, code: 'IN_STOCK' });
    });

    it('refuses a book that is not for sale at all', async () => {
      await expect(submit('noPrice')).rejects.toMatchObject({ statusCode: 409, code: 'NOT_FOR_SALE' });
    });

    it('refuses a book that cannot be sold in the customer\'s country', async () => {
      await expect(submit('restrictedGb', { country: 'GB' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'MARKET_RESTRICTED',
      });
    });

    it('does not turn a customer away when their country is unknown', async () => {
      await expect(submit('restrictedGb', { country: null })).resolves.toHaveProperty('reference');
    });

    it('refuses an out-of-print book, which no restock will bring back', async () => {
      await expect(submit('outOfPrint')).rejects.toMatchObject({ statusCode: 409, code: 'UNAVAILABLE' });
    });

    it('accepts a book that is reprinting', async () => {
      await expect(submit('reprinting', { country: null })).resolves.toHaveProperty('reference');
    });

    it('does not refuse a customer whose country has no Gardners region mapping', async () => {
      // XX is a valid-looking code that maps to no region; add-to-cart would block.
      await expect(submit('restrictedGb', { country: 'XX' })).resolves.toHaveProperty('reference');
    });

    it('calls an in-stock title restricted for the customer restricted, not in stock', async () => {
      await expect(submit('inStockRestrictedGb', { country: 'GB' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'MARKET_RESTRICTED',
      });
      await expect(submit('inStockRestrictedGb', { country: null })).rejects.toMatchObject({ code: 'IN_STOCK' });
    });

    it('stamps the reference in the same write as the row', async () => {
      const [{ n }] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM restock_requests
        WHERE isbn13 IN (${sql.join(ISBNS.map((i) => sql`${i}`), sql`, `)}) AND reference IS NULL
      `);
      expect(n).toBe(0);
    });

    it('404s a book that does not exist', async () => {
      await expect(
        customer.submit({ bookId: 2_000_000_000, userId: null, name: null, email: null, country: 'GB' }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'BOOK_NOT_FOUND' });
    });
  });

  describe('what gets stored', () => {
    it('files a signed-in customer under their account without the form', async () => {
      const { reference } = await submit('outOfStockHardback', { userId: realUserId });
      const [row] = await db.execute<{ name: string; email: string; user_id: number }>(sql`
        SELECT name, email, user_id FROM restock_requests WHERE reference = ${reference}
      `);
      expect(row).toEqual({ name: 'Amara Diallo', email: EMAIL_PREFIX + 'amara@example.com', user_id: realUserId });
    });

    it('never copies a web-shop guest account\'s placeholder name and address', async () => {
      const { reference } = await submit('outOfStockHardback', { userId: guestUserId });
      const [row] = await db.execute<{ name: string | null; email: string | null; user_id: number }>(sql`
        SELECT name, email, user_id FROM restock_requests WHERE reference = ${reference}
      `);
      expect(row).toEqual({ name: null, email: null, user_id: guestUserId });
    });

    it('keeps every press, even a repeat from the same person', async () => {
      await submit('outOfStock', { name: 'Priya Nair', email: EMAIL_PREFIX + 'priya@books.in' });
      const [{ n }] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM restock_requests WHERE email = ${EMAIL_PREFIX + 'priya@books.in'}
      `);
      expect(n).toBe(2);
    });
  });

  describe('the admin screen', () => {
    const q = TITLE_PREFIX;

    it('shows one card per edition, newest request first, with request counts', async () => {
      const result = await admin.list({ q, limit: 20, offset: 0 });

      // Paperback (2 requests), hardback (2), restricted title (2), reprinting (1).
      expect(result.totalCards).toBe(4);
      expect(result.totalRequests).toBe(7);
      expect(result.counts).toEqual({ total: 7, pending: 7, fulfilled: 0 });

      // The paperback got the most recent request.
      const [first] = result.cards;
      expect(first.book).toMatchObject({
        id: bookIds.outOfStock,
        title: `${TITLE_PREFIX} Wandering Stars`,
        author: 'Tommy Orange',
        format: 'Paperback',
        isbn13: ISBN.outOfStock,
      });
      expect(first.requestCount).toBe(2);
      const times = first.requests.map((r) => r.requestedAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));

      const hardback = result.cards.find((c) => c.book.id === bookIds.outOfStockHardback);
      expect(hardback?.book.format).toBe('Hardcover');
      // The guest request reads as anonymous.
      expect(hardback?.requests.some((r) => r.anonymous && r.email === null)).toBe(true);
    });

    it('searches customer email and ISBN as well as title', async () => {
      const byEmail = await admin.list({ q: EMAIL_PREFIX + 'amara', limit: 20, offset: 0 });
      expect(byEmail.totalRequests).toBe(1);
      expect(byEmail.cards[0].book.id).toBe(bookIds.outOfStockHardback);

      const byIsbn = await admin.list({ q: ISBN.restrictedGb, limit: 20, offset: 0 });
      expect(byIsbn.cards.map((c) => c.book.id)).toEqual([bookIds.restrictedGb]);
    });

    it('treats LIKE wildcards in a search as literal characters', async () => {
      const result = await admin.list({ q: 'restock_test', limit: 20, offset: 0 });
      expect(result.totalRequests).toBe(0);
    });

    it('marks one request fulfilled, keeps the first time on a repeat, and undoes', async () => {
      const { cards } = await admin.list({ q, limit: 20, offset: 0 });
      const id = cards[0].requests[0].id;

      const first = await admin.fulfil(id, adminId);
      expect(first.status).toBe('fulfilled');
      const again = await admin.fulfil(id, adminId);
      expect(again.fulfilledAt?.getTime()).toBe(first.fulfilledAt?.getTime());

      const counts = (await admin.list({ q, limit: 20, offset: 0 })).counts;
      expect(counts).toEqual({ total: 7, pending: 6, fulfilled: 1 });

      const undone = await admin.reopen(id);
      expect(undone).toMatchObject({ status: 'pending', fulfilledAt: null });
    });

    it('fulfils every pending request on a card at once', async () => {
      const { fulfilledIds } = await admin.fulfilAllForBook(bookIds.outOfStockHardback, adminId);
      expect(fulfilledIds).toHaveLength(2);

      const fulfilled = await admin.list({ q, status: 'fulfilled', limit: 20, offset: 0 });
      expect(fulfilled.cards.map((c) => c.book.id)).toEqual([bookIds.outOfStockHardback]);
      // Tab counts ignore the tab.
      expect(fulfilled.counts).toEqual({ total: 7, pending: 5, fulfilled: 2 });

      const pending = await admin.list({ q, status: 'pending', limit: 20, offset: 0 });
      expect(pending.cards.map((c) => c.book.id)).not.toContain(bookIds.outOfStockHardback);
    });

    it('pages by card, so a card is never split across pages', async () => {
      const page1 = await admin.list({ q, limit: 1, offset: 0 });
      const page2 = await admin.list({ q, limit: 1, offset: 1 });
      expect(page1.cards).toHaveLength(1);
      expect(page1.cards[0].requests).toHaveLength(page1.cards[0].requestCount);
      expect(page2.cards[0].book.id).not.toBe(page1.cards[0].book.id);
    });

    it('exports one row per request in the current filter', async () => {
      const { rows, total } = await admin.exportRows({ q, status: 'pending' }, 5000);
      expect(total).toBe(5);
      expect(rows.every((r) => r.status === 'pending')).toBe(true);
      expect(rows[0]).toMatchObject({ author: 'Tommy Orange' });
    });

    it('404s an unknown request', async () => {
      await expect(admin.reopen(2_000_000_000)).rejects.toMatchObject({ statusCode: 404 });
      await expect(admin.fulfil(2_000_000_000, adminId)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('counts pending requests on the sidebar badge', async () => {
      const [{ n }] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM restock_requests WHERE status = 'pending'
      `);
      const result = await badges.badges();
      expect(result.restockRequests).toBe(n);
    });
  });

  describe('the admin routes, over HTTP', () => {
    let server: Server;
    let base: string;
    let token: string;

    beforeAll(async () => {
      const { default: adminRoutes } = await import('../routes/admin');
      const { config } = await import('../config');
      const app = express();
      app.use(express.json());
      app.use('/admin/console', adminRoutes);
      server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      token = jwt.sign(
        { sub: adminId, email: EMAIL_PREFIX + 'admin@example.com', kind: 'admin', iat: Math.floor(Date.now() / 1000) - 60 },
        config.jwt.adminSecret!,
        { expiresIn: 3600 },
      );
    });

    afterAll(async () => {
      await new Promise((resolve) => server?.close(resolve));
    });

    function call(method: string, path: string, bearer: string | null = token) {
      return fetch(`${base}/admin/console${path}`, {
        method,
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      });
    }

    it('needs an admin session', async () => {
      expect((await call('GET', '/restock-requests', null)).status).toBe(401);
    });

    it('treats status=all as no filter, and rejects an unknown tab', async () => {
      const all = await call('GET', `/restock-requests?status=all&q=${TITLE_PREFIX}`);
      expect(all.status).toBe(200);
      const body = (await all.json()) as { totalRequests: number; counts: { total: number } };
      expect(body.totalRequests).toBe(body.counts.total);

      expect((await call('GET', '/restock-requests?status=dismissed')).status).toBe(400);
    });

    it('exports a CSV with the agreed columns, one row per request', async () => {
      const res = await call('GET', `/restock-requests/export?status=pending&q=${TITLE_PREFIX}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      const lines = (await res.text()).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      expect(lines[0]).toBe('Reference,Requested,Title,Author,Format,ISBN,Customer,Email,Signed in,Status,Fulfilled');
      expect(lines).toHaveLength(1 + Number(res.headers.get('x-total-rows')));
      expect(lines.slice(1).every((l) => l.includes(',Pending,'))).toBe(true);
    });

    it('400s a bad id and 404s an unknown one', async () => {
      expect((await call('POST', '/restock-requests/abc/fulfil')).status).toBe(400);
      expect((await call('POST', '/restock-requests/0/reopen')).status).toBe(400);
      expect((await call('POST', '/restock-requests/books/x/fulfil')).status).toBe(400);
      expect((await call('POST', '/restock-requests/2000000000/fulfil')).status).toBe(404);
    });

    it('fulfils and reopens through the routes', async () => {
      const [{ id }] = await db.execute<{ id: number }>(sql`
        SELECT id FROM restock_requests WHERE isbn13 = ${ISBN.reprinting} LIMIT 1
      `);
      const fulfilled = await call('POST', `/restock-requests/${id}/fulfil`);
      expect(await fulfilled.json()).toMatchObject({ id, status: 'fulfilled' });
      const reopened = await call('POST', `/restock-requests/${id}/reopen`);
      expect(await reopened.json()).toMatchObject({ id, status: 'pending', fulfilledAt: null });
    });

    it('fulfils a whole card through the route', async () => {
      const res = await call('POST', `/restock-requests/books/${bookIds.reprinting}/fulfil`);
      expect(await res.json()).toMatchObject({ bookId: bookIds.reprinting, fulfilledIds: [expect.any(Number)] });
    });
  });
});
