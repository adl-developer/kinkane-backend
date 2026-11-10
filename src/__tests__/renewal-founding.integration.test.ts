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

const scheduleFoundingRollover = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/subscriptions/schedules.service', () => ({
  schedulesService: { scheduleFoundingRollover: (...args: unknown[]) => scheduleFoundingRollover(...args) },
}));

/** A Stripe invoice preview whose single line bills `priceId`. */
function preview(total: number, priceId: string, extra: Record<string, unknown> = {}) {
  return { total, amount_due: total, currency: 'usd', lines: { data: [{ pricing: { price_details: { price: priceId } } }] }, ...extra };
}

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
  opts: {
    renewsInDays: number;
    priceId?: string;
    provider?: 'stripe' | 'apple';
    cancelling?: boolean;
    pendingPlan?: 'monthly' | 'annual';
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_subscriptions
      (user_id, tier, status, plan, price_id, current_period_end, cancel_at_period_end,
       stripe_subscription_id, billing_provider, pending_plan)
    VALUES (${userId}, 'plus', 'active', 'monthly', ${opts.priceId ?? 'price_monthly'},
            ${new Date(NOW.getTime() + opts.renewsInDays * DAY).toISOString()}, ${opts.cancelling ?? false},
            ${`sub_${userId}`}, ${opts.provider ?? 'stripe'}, ${opts.pendingPlan ?? null})`);
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
    createPreview.mockReset().mockResolvedValue(preview(699, 'price_monthly'));
    scheduleFoundingRollover.mockClear();
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

  // Right after deploy (or a failed attach on invoice.paid) the switch to
  // standard may not be in Stripe yet; it must be before the amount is read.
  it('attaches the founding rollover before asking Stripe for the amount', async () => {
    const userId = await makeUser('attach');
    await subscribe(userId, { renewsInDays: 2, priceId: 'price_monthly_founding' });

    await run();
    expect(scheduleFoundingRollover).toHaveBeenCalledWith(`sub_${userId}`, userId);
    expect(scheduleFoundingRollover.mock.invocationCallOrder[0]).toBeLessThan(
      createPreview.mock.invocationCallOrder[0],
    );
  });

  it('leaves the rollover alone for standard-price subscribers', async () => {
    await subscribe(await makeUser('standard'), { renewsInDays: 2 });

    await run();
    expect(scheduleFoundingRollover).not.toHaveBeenCalled();
  });

  // The switch lands at this renewal, so the email names the plan being billed.
  it('names the pending plan when a switch takes effect at this renewal', async () => {
    createPreview.mockResolvedValue(preview(5999, 'price_annual'));
    await subscribe(await makeUser('switching'), { renewsInDays: 2, pendingPlan: 'annual' });

    await run();
    expect(enqueueEmail.mock.calls[0][1]).toMatchObject({ plan: 'annual', amountCents: 5999 });
  });

  // Account credit lowers amount_due, not the price of the renewal.
  it('quotes the renewal total, not what is left after account credit', async () => {
    createPreview.mockResolvedValue(preview(699, 'price_monthly', { amount_due: 0 }));
    await subscribe(await makeUser('credit'), { renewsInDays: 2 });

    await run();
    expect(enqueueEmail.mock.calls[0][1]).toMatchObject({ amountCents: 699 });
  });

  // If Stripe still bills the founding price, the email must not announce a
  // rise — even when tax makes the total differ from the founding price.
  it('sends the normal wording when Stripe still bills the founding price, tax included', async () => {
    createPreview.mockResolvedValue(preview(719, 'price_monthly_founding'));
    await subscribe(await makeUser('stuck'), { renewsInDays: 2, priceId: 'price_monthly_founding' });

    await run();
    expect(enqueueEmail.mock.calls[0][1]).toMatchObject({ amountCents: 719, foundingAmountCents: null });
  });

  // Every worker runs the sweep at once; the claim comes first, so Stripe is
  // asked once per subscriber between them, and one email goes out.
  it('calls Stripe once when two workers run at the same moment', async () => {
    await subscribe(await makeUser('race'), { renewsInDays: 5 });

    const results = await Promise.all([run(), run()]);

    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(createPreview).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it('retries the next day when Stripe fails', async () => {
    await subscribe(await makeUser('flaky'), { renewsInDays: 4 });
    createPreview.mockRejectedValueOnce(new Error('Stripe is down'));

    expect(await run()).toBe(0);
    expect(await run()).toBe(1);
  });
});
