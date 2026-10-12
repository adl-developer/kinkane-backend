import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * POST /users/:userId/follow over HTTP, against a real Postgres.
 *
 * WHY THIS EXISTS. Follows go one way, so someone can ask to follow a person
 * whose request to them is still waiting. The service-level test in
 * friend-request-notifications.integration.test.ts proves the service allows
 * it; this proves the endpoint does too, so a check reintroduced in the
 * controller or route wiring can't quietly bring the old 409 back.
 *
 * The real users router is mounted with auth and rate limiting stubbed out:
 * the limiters need Redis, and signing JWTs adds nothing to what's tested.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users. Skips itself when unset; refuses to run when it names the same
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

// The caller is whoever the x-test-user header names.
vi.mock('../middleware/auth.middleware', () => {
  const asHeaderUser = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: { id: number; email: string } }).user = {
      id: Number(req.headers['x-test-user']),
      email: 'test@example.com',
    };
    next();
  };
  return { requireAuth: asHeaderUser, optionalAuth: asHeaderUser };
});
vi.mock('../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { followRequestLimiter: pass, usernameCheckLimiter: pass };
});
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification-preferences.service', () => ({
  notificationPreferencesService: { isEnabled: vi.fn().mockResolvedValue(false) },
}));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'follow-endpoint-test-';

describeIfDb('POST /users/:userId/follow', () => {
  let server: Server;
  let base: string;
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    const { default: usersRoutes } = await import('../routes/users.routes');

    const app = express();
    app.use(express.json());
    app.use('/users', usersRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  async function cleanUp(): Promise<void> {
    // Cascades through follow_requests and notifications.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function createUser(name: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES (${name}, ${`${EMAIL_PREFIX}${name.toLowerCase()}@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function follow(caller: number, target: number) {
    const res = await fetch(`${base}/users/${target}/follow`, {
      method: 'POST',
      headers: { 'x-test-user': String(caller) },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeEach(async () => {
    await cleanUp();
    alice = await createUser('Alice');
    bob = await createUser('Bob');
  });

  afterAll(async () => {
    if (!testUrl) return;
    server?.close();
    await cleanUp();
  });

  it('accepts a request back to someone whose request to the caller is still pending', async () => {
    expect(await follow(alice, bob)).toEqual({ status: 201, body: { success: true } });
    expect(await follow(bob, alice)).toEqual({ status: 201, body: { success: true } });

    const rows = (await db.execute(sql`
      SELECT sender_id, status::text AS status FROM follow_requests
      WHERE sender_id IN (${alice}, ${bob})
    `)) as unknown as { sender_id: number; status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('still refuses a repeat of the caller\'s own pending request, with no code', async () => {
    await follow(alice, bob);
    expect(await follow(alice, bob)).toEqual({ status: 409, body: { error: 'Follow request already sent' } });
  });
});
