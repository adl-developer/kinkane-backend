import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * The admin console's forgotten-password flow, over HTTP, against a real
 * Postgres.
 *
 * What matters here is what an attacker can learn or do with it: the request
 * endpoint must answer the same for staff and non-staff addresses, a link must
 * work exactly once, and a disabled admin must not be able to use it to get
 * back in.
 *
 * The real admin router is mounted with rate limiting stubbed out (the limiter
 * needs Redis) and the email queue mocked, so the test can read the link the
 * admin would have been sent.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * admins. Skips itself when unset; refuses to run when it names the same
 * database as `.env`. Setup as in nielsen-budget.integration.test.ts.
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

const enqueueEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/email-queue', () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args) }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    adminLoginLimiter: pass,
    adminPasswordResetLimiter: pass,
    adminPasswordResetEmailLimiter: pass,
  };
});

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'admin-reset-test-';
const OLD_PASSWORD = 'old-password-123456';
const NEW_PASSWORD = 'new-password-654321';

describeIfDb('admin console password reset', () => {
  let server: Server;
  let base: string;
  let adminId: number;
  const email = `${EMAIL_PREFIX}ama@example.com`;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    const { default: adminRoutes } = await import('../routes/admin');

    const app = express();
    app.use(express.json());
    app.use('/admin/console', adminRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  async function cleanUp(): Promise<void> {
    // Cascades through admin_password_reset_tokens.
    await db.execute(sql`DELETE FROM admins WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function post(path: string, payload: unknown, bearer?: string) {
    const res = await fetch(`${base}/admin/console${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function me(bearer: string): Promise<number> {
    const res = await fetch(`${base}/admin/console/auth/me`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    return res.status;
  }

  /**
   * A console token issued a minute ago. Backdated because `iat` is whole
   * seconds and a token minted in the same second as a password change is
   * deliberately allowed to survive it.
   */
  async function oldSession(): Promise<string> {
    const { config } = await import('../config');
    return jwt.sign(
      { sub: adminId, email, kind: 'admin', iat: Math.floor(Date.now() / 1000) - 60 },
      config.jwt.adminSecret!,
      { expiresIn: 3600 },
    );
  }

  // forgot-password answers before doing its work, so a test has to wait for
  // the work: for the email when one is expected, for the token row otherwise.
  async function requestAndSettle(address: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await post('/auth/forgot-password', { email: address });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return res;
  }

  /** Asks for a link and returns the token the admin would have been emailed. */
  async function requestToken(): Promise<string> {
    enqueueEmail.mockClear();
    await post('/auth/forgot-password', { email });
    await vi.waitFor(() => expect(enqueueEmail).toHaveBeenCalledTimes(1));
    const { resetUrl } = enqueueEmail.mock.calls[0][1] as { resetUrl: string };
    return new URL(resetUrl).searchParams.get('token')!;
  }

  async function storedHash(): Promise<string> {
    const [row] = (await db.execute(sql`
      SELECT password_hash FROM admins WHERE id = ${adminId}
    `)) as unknown as { password_hash: string }[];
    return row.password_hash;
  }

  beforeEach(async () => {
    await cleanUp();
    enqueueEmail.mockClear();
    const [row] = (await db.execute(sql`
      INSERT INTO admins (name, email, password_hash)
      VALUES ('Ama', ${email}, ${await bcrypt.hash(OLD_PASSWORD, 4)})
      RETURNING id
    `)) as unknown as { id: number }[];
    adminId = row.id;
  });

  afterAll(async () => {
    if (!testUrl) return;
    server?.close();
    await cleanUp();
  });

  it('emails a reset link to an active admin and the link sets the new password', async () => {
    const res = await post('/auth/forgot-password', { email: email.toUpperCase() });
    expect(res).toEqual({ status: 200, body: { sent: true } });

    await vi.waitFor(() => expect(enqueueEmail).toHaveBeenCalledTimes(1));
    expect(enqueueEmail).toHaveBeenCalledWith('admin-password-reset', expect.objectContaining({
      to: email,
      name: 'Ama',
      expiryMinutes: 30,
    }));
    const { resetUrl } = enqueueEmail.mock.calls[0][1] as { resetUrl: string };
    expect(resetUrl).toMatch(/\/reset-password\?token=[0-9a-f]{64}$/);
    const token = new URL(resetUrl).searchParams.get('token')!;

    expect(await post('/auth/reset-password', { token, newPassword: NEW_PASSWORD }))
      .toEqual({ status: 200, body: { reset: true } });
    expect(await bcrypt.compare(NEW_PASSWORD, await storedHash())).toBe(true);
  });

  it('answers the same for an address that is not an admin, and sends nothing', async () => {
    const res = await requestAndSettle(`${EMAIL_PREFIX}nobody@example.com`);
    expect(res).toEqual({ status: 200, body: { sent: true } });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('sends nothing to a disabled admin', async () => {
    await db.execute(sql`UPDATE admins SET disabled_at = now() WHERE id = ${adminId}`);
    expect(await requestAndSettle(email)).toEqual({ status: 200, body: { sent: true } });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('refuses a link a second time', async () => {
    const token = await requestToken();
    expect((await post('/auth/reset-password', { token, newPassword: NEW_PASSWORD })).status).toBe(200);

    const again = await post('/auth/reset-password', { token, newPassword: 'another-password-999' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_RESET_TOKEN');
    expect(await bcrypt.compare(NEW_PASSWORD, await storedHash())).toBe(true);
  });

  it('refuses an earlier link once a newer one has been requested', async () => {
    const first = await requestToken();
    const second = await requestToken();

    expect((await post('/auth/reset-password', { token: first, newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await post('/auth/reset-password', { token: second, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it('refuses an expired link', async () => {
    const token = await requestToken();
    await db.execute(sql`
      UPDATE admin_password_reset_tokens SET expires_at = now() - interval '1 minute'
      WHERE admin_id = ${adminId}
    `);

    const res = await post('/auth/reset-password', { token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(await bcrypt.compare(OLD_PASSWORD, await storedHash())).toBe(true);
  });

  it('refuses a link once the admin has been disabled', async () => {
    const token = await requestToken();
    await db.execute(sql`UPDATE admins SET disabled_at = now() WHERE id = ${adminId}`);

    const res = await post('/auth/reset-password', { token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESET_TOKEN');
    expect(await bcrypt.compare(OLD_PASSWORD, await storedHash())).toBe(true);
  });

  it('refuses a new password under 12 characters', async () => {
    const token = await requestToken();
    expect((await post('/auth/reset-password', { token, newPassword: 'short' })).status).toBe(400);
    expect(await bcrypt.compare(OLD_PASSWORD, await storedHash())).toBe(true);
  });

  it('keeps one live link when two requests land at once', async () => {
    await Promise.all([post('/auth/forgot-password', { email }), post('/auth/forgot-password', { email })]);
    await vi.waitFor(() => expect(enqueueEmail).toHaveBeenCalledTimes(2));

    const rows = (await db.execute(sql`
      SELECT id FROM admin_password_reset_tokens WHERE admin_id = ${adminId}
    `)) as unknown as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('signs out sessions issued before the reset', async () => {
    const before = await oldSession();
    expect(await me(before)).toBe(200);

    const token = await requestToken();
    expect((await post('/auth/reset-password', { token, newPassword: NEW_PASSWORD })).status).toBe(200);

    expect(await me(before)).toBe(401);
    const login = await post('/auth/login', { email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(await me(login.body.token as string)).toBe(200);
  });

  it('change-password signs out other sessions and hands back a working one', async () => {
    const other = await oldSession();
    const caller = await oldSession();

    const res = await post(
      '/auth/change-password',
      { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      caller,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, admin: { id: adminId, email } });

    expect(await me(other)).toBe(401);
    expect(await me(caller)).toBe(401);
    expect(await me(res.body.token as string)).toBe(200);
  });
});
