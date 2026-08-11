import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Cancellation is the one billing action users take under stress, and both ways
 * of getting it wrong are expensive:
 *
 *   - cancelling *immediately* takes away a period the user already paid for,
 *     which reads as theft and produces a refund request;
 *   - failing to mirror Stripe locally leaves the account screen claiming the
 *     subscription is still renewing, so the user cancels again, and again.
 *
 * These tests pin the contract with Stripe and the local write, with the Stripe
 * client and the state service mocked — there is no Stripe account in CI, and
 * the interesting behaviour is which arguments we send, not what Stripe does.
 */

const stripeUpdate = vi.fn();
const stripeRetrieve = vi.fn();
const stripeCancel = vi.fn();
const scheduleCreate = vi.fn();
const scheduleUpdate = vi.fn();
const scheduleRelease = vi.fn();
const applyState = vi.fn();
const getCurrent = vi.fn();
const get = vi.fn();
const invalidate = vi.fn();

vi.mock('../lib/stripe', () => ({
  stripe: () => ({
    subscriptions: { update: stripeUpdate, retrieve: stripeRetrieve, cancel: stripeCancel },
    subscriptionSchedules: {
      create: scheduleCreate,
      update: scheduleUpdate,
      release: scheduleRelease,
    },
  }),
  assertStripeConfigured: () => undefined,
  isStripeConfigured: () => true,
  resolvePrice: () => ({
    priceId: 'price_monthly_founding',
    standardPriceId: 'price_monthly',
    isFounding: true,
  }),
  planForPriceId: () => 'monthly',
  isFoundingWindowOpen: () => false,
}));

vi.mock('../services/subscriptions/state.service', () => ({
  subscriptionStateService: {
    getCurrent: (...args: unknown[]) => getCurrent(...args),
    get: (...args: unknown[]) => get(...args),
    applyState: (...args: unknown[]) => applyState(...args),
  },
}));

vi.mock('../services/subscriptions/entitlements.service', () => ({
  entitlementsService: { invalidate: (...args: unknown[]) => invalidate(...args) },
}));

const PERIOD_END = Math.floor(new Date('2026-09-01T00:00:00Z').getTime() / 1000);

/** A paying subscriber, mid-term. */
const PAYING = {
  userId: 7,
  tier: 'plus',
  status: 'active',
  plan: 'monthly',
  priceId: 'price_monthly',
  isFoundingMember: false,
  currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
};

/**
 * A Founding Member. Their subscription is managed by a price schedule, which
 * is the case the original tests never covered — and while it wasn't covered,
 * cancellation was rejected outright by Stripe for every one of these users.
 */
const FOUNDING = {
  ...PAYING,
  priceId: 'price_monthly_founding',
  isFoundingMember: true,
};

/** What Stripe returns for a subscription, with or without a schedule on it. */
function stripeSubscription(schedule: string | null, priceId = 'price_monthly') {
  return {
    id: 'sub_1',
    schedule,
    items: { data: [{ current_period_end: PERIOD_END, price: { id: priceId } }] },
  };
}

async function loadService() {
  vi.resetModules();
  return (await import('../services/subscriptions/checkout.service')).checkoutService;
}

beforeEach(() => {
  stripeUpdate.mockReset();
  stripeRetrieve.mockReset();
  stripeCancel.mockReset();
  scheduleCreate.mockReset();
  scheduleUpdate.mockReset();
  scheduleRelease.mockReset();
  applyState.mockReset();
  getCurrent.mockReset();
  get.mockReset();
  invalidate.mockReset();

  // Default: an ordinary subscriber, no schedule attached.
  stripeRetrieve.mockResolvedValue(stripeSubscription(null));
  stripeUpdate.mockResolvedValue(stripeSubscription(null));
  scheduleCreate.mockResolvedValue({
    id: 'sub_sched_2',
    phases: [{ start_date: 1, end_date: 2 }],
  });
  applyState.mockImplementation(async (_userId: number, next: Record<string, unknown>) => ({
    ...PAYING,
    ...next,
  }));
});

afterEach(() => vi.restoreAllMocks());

describe('cancel', () => {
  // The single most important assertion in this file. `cancel_at_period_end`
  // stops future billing; `cancel()` would end it on the spot.
  it('schedules cancellation at period end, never immediately', async () => {
    getCurrent.mockResolvedValue(PAYING);
    const service = await loadService();

    const result = await service.cancel(7);

    expect(stripeUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.accessEndsAt).toEqual(new Date('2026-09-01T00:00:00Z'));
  });

  // The user keeps what they paid for, so the account screen must still say Plus.
  it('leaves the user entitled until the period ends', async () => {
    getCurrent.mockResolvedValue(PAYING);
    const service = await loadService();

    const result = await service.cancel(7);

    expect(result.tier).toBe('plus');
    expect(result.status).toBe('active');
  });

  it('mirrors the cancellation locally rather than waiting for the webhook', async () => {
    getCurrent.mockResolvedValue(PAYING);
    const service = await loadService();

    await service.cancel(7);

    expect(applyState).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ cancelAtPeriodEnd: true, stripeSubscriptionId: 'sub_1' }),
      expect.objectContaining({ reason: 'subscription_updated' }),
    );
  });

  it('drops the cached entitlement so the next request re-reads', async () => {
    getCurrent.mockResolvedValue(PAYING);
    const service = await loadService();
    await service.cancel(7);
    expect(invalidate).toHaveBeenCalledWith(7);
  });

  // The 90-day trial is ours, not Stripe's — there is no subscription object.
  it('refuses for a trialing user instead of calling Stripe', async () => {
    getCurrent.mockResolvedValue({ ...PAYING, status: 'trialing', stripeSubscriptionId: null });
    const service = await loadService();

    await expect(service.cancel(7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'NO_PAID_SUBSCRIPTION',
    });
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  it('404s when there is no subscription row at all', async () => {
    getCurrent.mockResolvedValue(null);
    const service = await loadService();
    await expect(service.cancel(7)).rejects.toMatchObject({ statusCode: 404 });
  });

  // A double-tap on a Cancel button is not a mistake worth surfacing.
  it('is idempotent for an already-cancelling subscription', async () => {
    getCurrent.mockResolvedValue({ ...PAYING, cancelAtPeriodEnd: true });
    const service = await loadService();

    const result = await service.cancel(7);
    expect(result.cancelAtPeriodEnd).toBe(true);
  });

  // The regression this file exists to prevent. Stripe rejects cancellation
  // outright on a schedule-managed subscription ("updating any cancelation
  // behavior directly is not allowed"), so the schedule has to be released
  // first — and it has to be released BEFORE the update, not after.
  it('releases a Founding Member from their price schedule before cancelling', async () => {
    getCurrent.mockResolvedValue(FOUNDING);
    stripeRetrieve.mockResolvedValue(stripeSubscription('sub_sched_1', 'price_monthly_founding'));
    const service = await loadService();

    const result = await service.cancel(7);

    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_1');
    expect(scheduleRelease.mock.invocationCallOrder[0]).toBeLessThan(
      stripeUpdate.mock.invocationCallOrder[0],
    );
    expect(stripeUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
    expect(result.cancelAtPeriodEnd).toBe(true);
  });

  // Releasing is only for subscriptions that are actually managed by one.
  it('does not touch schedules for an ordinary subscriber', async () => {
    getCurrent.mockResolvedValue(PAYING);
    const service = await loadService();

    await service.cancel(7);

    expect(scheduleRelease).not.toHaveBeenCalled();
    expect(stripeUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });
  });

  // If the release fails the cancellation cannot go through, and reporting
  // success would tell the user they've stopped paying while Stripe bills on.
  it('fails loudly when the schedule cannot be released', async () => {
    getCurrent.mockResolvedValue(FOUNDING);
    stripeRetrieve.mockResolvedValue(stripeSubscription('sub_sched_1', 'price_monthly_founding'));
    scheduleRelease.mockRejectedValue(new Error('schedule already released'));
    const service = await loadService();

    await expect(service.cancel(7)).rejects.toThrow('schedule already released');
    expect(stripeUpdate).not.toHaveBeenCalled();
    expect(applyState).not.toHaveBeenCalled();
  });
});

describe('reactivate', () => {
  it('clears the scheduled cancellation', async () => {
    getCurrent.mockResolvedValue({ ...PAYING, cancelAtPeriodEnd: true });
    const service = await loadService();

    const result = await service.reactivate(7);

    expect(stripeUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false });
    expect(result.cancelAtPeriodEnd).toBe(false);
  });

  // Past the period end Stripe has deleted the subscription; flipping a flag on
  // it would 404 at Stripe. Better to say "start a new one" than to relay that.
  it('refuses once the subscription has actually ended', async () => {
    getCurrent.mockResolvedValue({ ...PAYING, status: 'cancelled', cancelAtPeriodEnd: true });
    const service = await loadService();

    await expect(service.reactivate(7)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SUBSCRIPTION_ENDED',
    });
    expect(stripeUpdate).not.toHaveBeenCalled();
  });

  // Cancelling released them from the founding→standard rollover. Without
  // putting it back, a Founding Member who cancelled and changed their mind
  // would keep the introductory price forever.
  it('re-attaches the founding price schedule, after clearing the flag', async () => {
    getCurrent.mockResolvedValue({ ...FOUNDING, cancelAtPeriodEnd: true });
    stripeUpdate.mockResolvedValue(stripeSubscription(null, 'price_monthly_founding'));
    const service = await loadService();

    await service.reactivate(7);

    expect(scheduleCreate).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
    // Order matters: a schedule built from a subscription inherits its
    // cancellation behaviour, so the flag must be cleared first.
    expect(stripeUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      scheduleCreate.mock.invocationCallOrder[0],
    );
    expect(scheduleUpdate).toHaveBeenCalledWith(
      'sub_sched_2',
      expect.objectContaining({ end_behavior: 'release' }),
    );
  });

  it('does not attach a schedule for an ordinary subscriber', async () => {
    getCurrent.mockResolvedValue({ ...PAYING, cancelAtPeriodEnd: true });
    const service = await loadService();

    await service.reactivate(7);

    expect(scheduleCreate).not.toHaveBeenCalled();
  });
});

/**
 * Deleting an account cascades away user_subscriptions, taking the only record
 * of which Stripe subscription belonged to that user. Anything not cancelled
 * before that point bills a card forever with nothing left tying it to anyone —
 * so this is the one cancellation path where "immediately" is correct.
 */
describe('terminateForAccountDeletion', () => {
  it('cancels immediately rather than at period end', async () => {
    get.mockResolvedValue(PAYING);
    const service = await loadService();

    const stopped = await service.terminateForAccountDeletion(7);

    expect(stripeCancel).toHaveBeenCalledWith('sub_1');
    // Period-end would bill nobody's account for a term nobody can use.
    expect(stripeUpdate).not.toHaveBeenCalled();
    expect(stopped).toBe(true);
  });

  it('releases a Founding Member schedule first, as the normal cancel path does', async () => {
    get.mockResolvedValue(FOUNDING);
    stripeRetrieve.mockResolvedValue(stripeSubscription('sub_sched_1', 'price_monthly_founding'));
    const service = await loadService();

    await service.terminateForAccountDeletion(7);

    expect(scheduleRelease).toHaveBeenCalledWith('sub_sched_1');
    expect(scheduleRelease.mock.invocationCallOrder[0]).toBeLessThan(
      stripeCancel.mock.invocationCallOrder[0],
    );
  });

  // The load-bearing property. Deletion is a right the user is exercising, and
  // Stripe being unreachable is our problem — if this threw, the account
  // deletion endpoint would 500 and they could not leave.
  it('never throws when Stripe fails, so deletion is never blocked', async () => {
    get.mockResolvedValue(PAYING);
    stripeCancel.mockRejectedValue(new Error('Stripe is down'));
    const service = await loadService();

    await expect(service.terminateForAccountDeletion(7)).resolves.toBe(false);
  });

  it('does nothing for a user who never paid', async () => {
    get.mockResolvedValue({ ...PAYING, status: 'trialing', stripeSubscriptionId: null });
    const service = await loadService();

    const stopped = await service.terminateForAccountDeletion(7);

    expect(stripeCancel).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
  });

  // Stripe rejects cancelling an already-cancelled subscription.
  it('does nothing for a subscription that already ended', async () => {
    get.mockResolvedValue({ ...PAYING, status: 'cancelled' });
    const service = await loadService();

    const stopped = await service.terminateForAccountDeletion(7);

    expect(stripeCancel).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
  });
});
