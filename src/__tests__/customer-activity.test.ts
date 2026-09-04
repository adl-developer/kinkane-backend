import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "Active" in the admin console means *seen in the last 12 months*, which only
 * works if something actually records being seen. Two properties matter here and
 * neither is visible from a single call site:
 *
 *  1. The recording is throttled. It runs on the auth middleware, so an
 *     unthrottled version puts a write on the hot path of every authenticated
 *     request in the app.
 *  2. The Customers list and the Overview card agree. They render the same word
 *     from two different queries; when those drifted apart before, the dashboard
 *     ended up arguing with itself.
 */

const where = vi.fn(() => Promise.resolve());
const set = vi.fn(() => ({ where }));
const update = vi.fn(() => ({ set }));

vi.mock('../db', () => ({ db: { update: (...args: unknown[]) => update(...(args as [])) } }));
vi.mock('../lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const loadService = async () => {
  const mod = await import('../services/user-activity.service');
  mod.__resetActivityCache();
  return mod;
};

describe('touchLastSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    where.mockImplementation(() => Promise.resolve());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the first time it sees an account', async () => {
    const { touchLastSignIn } = await loadService();
    touchLastSignIn(42);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('does not write again within the throttle window', async () => {
    const { touchLastSignIn } = await loadService();

    // A single screen load can fan out into a dozen authenticated calls. If each
    // one issued an UPDATE, this feature would cost more than the console it
    // serves.
    for (let i = 0; i < 20; i++) touchLastSignIn(42);

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('writes again once a day has passed', async () => {
    const { touchLastSignIn } = await loadService();
    touchLastSignIn(42);

    vi.setSystemTime(new Date('2026-09-05T10:00:01Z'));
    touchLastSignIn(42);

    expect(update).toHaveBeenCalledTimes(2);
  });

  it('throttles per account, not globally', async () => {
    const { touchLastSignIn } = await loadService();
    touchLastSignIn(1);
    touchLastSignIn(2);
    touchLastSignIn(1);

    expect(update).toHaveBeenCalledTimes(2);
  });

  it('retries on the next request when the write fails', async () => {
    const { touchLastSignIn } = await loadService();

    where.mockImplementationOnce(() => Promise.reject(new Error('connection lost')));
    touchLastSignIn(42);
    await vi.waitFor(() => expect(where).toHaveBeenCalledTimes(1));

    // Without clearing the guard on failure, a blip would silence this account
    // for a full day — and the operator would read that as a dormant customer.
    touchLastSignIn(42);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('never rejects into the caller', async () => {
    const { touchLastSignIn } = await loadService();
    where.mockImplementationOnce(() => Promise.reject(new Error('connection lost')));

    // It is called from auth middleware and deliberately not awaited: an
    // activity timestamp must never be able to fail somebody's request.
    expect(() => touchLastSignIn(42)).not.toThrow();
    await vi.waitFor(() => expect(where).toHaveBeenCalled());
  });
});

describe('recordSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    where.mockImplementation(() => Promise.resolve());
  });

  it('writes unconditionally and then satisfies the throttle', async () => {
    const { recordSignIn, touchLastSignIn } = await loadService();

    await recordSignIn(42);
    expect(update).toHaveBeenCalledTimes(1);

    // An explicit sign-in has just set the timestamp; the request that follows
    // it should not immediately write the same value again.
    touchLastSignIn(42);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('the "active" definition', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const customers = read('services/admin/customers.service.ts');
  const dashboard = read('services/admin/dashboard.service.ts');

  it('keys the Customers list off sign-in recency, not paid orders', () => {
    expect(customers).toContain('active: new Date(r.lastSignInAt) >= activeSince');
  });

  it('keys the Overview card off the same column', () => {
    // The card and the list must count the same people. Previously both read
    // orders.paid_at; both now read users.last_sign_in_at.
    expect(dashboard).toContain('gte(users.lastSignInAt, windowStart(ACTIVE_CUSTOMER_WINDOW_DAYS))');
  });

  it('still shares one window constant between them', () => {
    expect(customers).toContain("import { ACTIVE_CUSTOMER_WINDOW_DAYS } from './dashboard.service'");
    expect(dashboard).toContain('export const ACTIVE_CUSTOMER_WINDOW_DAYS = 365');
  });

  it('leaves the money columns counting paid orders only', () => {
    // Changing what "active" means must not quietly change what "total spent"
    // means — that is the number the revenue question is still asked of.
    expect(customers).toContain("o.paid_at is not null");
  });
});

describe('recording sightings', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('touches on any authenticated request, not just on password entry', () => {
    // The point of "last seen" over "last login": a mobile client silently
    // rotates tokens for months, so keying on credential entry would file the
    // heaviest users as dormant.
    const middleware = read('middleware/auth.middleware.ts');
    expect(middleware).toContain('touchLastSignIn');
    expect(middleware.match(/touchLastSignIn\(/g) ?? []).toHaveLength(2);
  });

  it('records every path that issues a session', () => {
    // issueTokenPair is the funnel for password, social, signup and refresh.
    const auth = read('services/auth.service.ts');
    expect(auth).toContain('recordSignIn(userId)');
  });
});
