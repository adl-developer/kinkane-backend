import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * Two rules from 2026-11-10, against a real Postgres:
 *
 *   - the founding price is one period, once per account: `foundingEndsAt`
 *     returns null once history shows a paid founding period;
 *   - every website renewal gets one reminder a week ahead, with the amount
 *     Stripe will actually charge.
 *
 * Stripe and the email queue are mocked. TEST_DATABASE_URL only; skips when
 * unset and refuses to run against the `.env` database (this suite deletes rows).
 */

const testUrl = process.env.TEST_DATABASE_URL;

if (testUrl) {
  let configured: string | undefined;
  try {
    configured = dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    configured = undefined;
  }
  const target = (url: string) => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return url;
    }
  };
  if (configured && target(configured) === target(testUrl)) {
    throw new Error('TEST_DATABASE_URL points at the same database as .env. Use a scratch database.');
  }
  process.env.DATABASE_URL = testUrl;
}

const enqueueEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/email-queue', () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args) }));

const createPreview = vi.fn();
const pricesRetrieve = vi.fn();
vi.mock('../lib/stripe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/stripe')>()),
  stripe: () => ({ invoices: { createPreview }, prices: { retrieve: pricesRetrieve } }),
  isStripeConfigured: () => true,
  isFoundingPriceId: (id: string | null | undefined) => Boolean(id?.endsWith('_founding')),
}));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'renewal-founding-test-';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-10T09:00:00Z');

async function makeUser(tag: string, createdAt = NOW): Promise<number> {
  const rows = await db.execute(
    sql`INSERT INTO users (name, email, created_at) VALUES ('Ama', ${`${EMAIL_PREFIX}${tag}@example.com`}, ${createdAt.toISOString()})
        RETURNING id`,
  );
  return Number((rows as unknown as { rows: { id: number }[] }).rows?.[0]?.id ?? (rows as unknown as { id: number }[])[0].id);
}

async function subscribe(
  userId: number,
  opts: { renewsInDays: number; priceId?: string; provider?: 'stripe' | 'apple'; cancelling?: boolean },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_subscriptions
      (user_id, tier, status, plan, price_id, current_period_end, cancel_at_period_end,
       stripe_subscription_id, billing_provider)
    VALUES (${userId}, 'plus', 'active', 'monthly', ${opts.priceId ?? 'price_monthly'},
            ${new Date(NOW.getTime() + opts.renewsInDays * DAY).toISOString()}, ${opts.cancelling ?? false},
            ${`sub_${userId}`}, ${opts.provider ?? 'stripe'})`);
}

describeIfDb('founding once per account', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  });
  afterAll(async () => {
    vi.useRealTimers();
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  });

  it('offers founding to a new account that has never paid it', async () => {
    const { subscriptionStateService } = await import('../services/subscriptions/state.service');
    const userId = await makeUser('new');
    expect(await subscriptionStateService.foundingEndsAt(userId)).toBeInstanceOf(Date);
  });

  it('stops offering it once a founding period has been paid, even after cancelling', async () => {
    const { subscriptionStateService } = await import('../services/subscriptions/state.service');
    const userId = await makeUser('used');
    await db.execute(sql`
      INSERT INTO subscription_state_history (user_id, tier, status, is_founding_member, reason, effective_to)
      VALUES (${userId}, 'plus', 'active', true, 'checkout_completed', ${NOW.toISOString()})`);
    expect(await subscriptionStateService.foundingEndsAt(userId)).toBeNull();
  });

  it('is not used up by a trial', async () => {
    const { subscriptionStateService } = await import('../services/subscriptions/state.service');
    const userId = await makeUser('trial');
    await db.execute(sql`
      INSERT INTO subscription_state_history (user_id, tier, status, is_founding_member, reason)
      VALUES (${userId}, 'free', 'trialing', false, 'signup')`);
    expect(await subscriptionStateService.foundingEndsAt(userId)).toBeInstanceOf(Date);
  });

  it('is null once the window has closed', async () => {
    const { subscriptionStateService } = await import('../services/subscriptions/state.service');
    const userId = await makeUser('old', new Date(NOW.getTime() - 400 * DAY));
    expect(await subscriptionStateService.foundingEndsAt(userId)).toBeNull();
  });
});

describeIfDb('renewal reminders', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
  });
  beforeEach(async () => {
    enqueueEmail.mockClear();
    createPreview.mockReset().mockResolvedValue({ amount_due: 699, currency: 'usd' });
    pricesRetrieve.mockReset().mockResolvedValue({ unit_amount: 599 });
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  });

  async function run(): Promise<number> {
    const { sendDueRenewalReminders } = await import('../jobs/renewal-reminder.cron');
    return sendDueRenewalReminders(NOW);
  }
  const sentTo = () => enqueueEmail.mock.calls.map((c) => (c[1] as { to: string }).to);

  it('emails a renewal within the week once, with Stripe’s amount', async () => {
    const userId = await makeUser('due');
    await subscribe(userId, { renewsInDays: 6 });

    expect(await run()).toBe(1);
    expect(enqueueEmail).toHaveBeenCalledWith('subscription-renewal-reminder', {
      to: `${EMAIL_PREFIX}due@example.com`,
      name: 'Ama',
      plan: 'monthly',
      renewsAt: new Date(NOW.getTime() + 6 * DAY).toISOString(),
      amountCents: 699,
      currency: 'usd',
      foundingAmountCents: null,
    });

    expect(await run()).toBe(0);
  });

  it('reminds again for the next period', async () => {
    const userId = await makeUser('next');
    await subscribe(userId, { renewsInDays: 6 });
    await run();
    await db.execute(sql`UPDATE user_subscriptions SET current_period_end = current_period_end + interval '1 day' WHERE user_id = ${userId}`);
    expect(await run()).toBe(1);
  });

  it('skips renewals further out, cancelling subscriptions and App Store subscribers', async () => {
    await subscribe(await makeUser('far'), { renewsInDays: 10 });
    await subscribe(await makeUser('cancelling'), { renewsInDays: 3, cancelling: true });
    await subscribe(await makeUser('apple'), { renewsInDays: 3, provider: 'apple' });

    expect(await run()).toBe(0);
    expect(sentTo()).toEqual([]);
  });

  it('flags the founding-to-standard renewal with both amounts', async () => {
    await subscribe(await makeUser('founding'), { renewsInDays: 2, priceId: 'price_monthly_founding' });

    await run();
    expect(enqueueEmail.mock.calls[0][1]).toMatchObject({ amountCents: 699, foundingAmountCents: 599 });
  });

  // If the rollover never attached, Stripe would bill founding again; the email
  // must not announce a price rise that isn't going to happen.
  it('sends the normal wording when Stripe still bills the founding amount', async () => {
    createPreview.mockResolvedValue({ amount_due: 599, currency: 'usd' });
    await subscribe(await makeUser('stuck'), { renewsInDays: 2, priceId: 'price_monthly_founding' });

    await run();
    expect(enqueueEmail.mock.calls[0][1]).toMatchObject({ amountCents: 599, foundingAmountCents: null });
  });

  it('retries the next day when Stripe fails', async () => {
    await subscribe(await makeUser('flaky'), { renewsInDays: 4 });
    createPreview.mockRejectedValueOnce(new Error('Stripe is down'));

    expect(await run()).toBe(0);
    expect(await run()).toBe(1);
  });
});
