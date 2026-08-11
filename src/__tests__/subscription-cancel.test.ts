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
const applyState = vi.fn();
const getCurrent = vi.fn();
const invalidate = vi.fn();

vi.mock('../lib/stripe', () => ({
  stripe: () => ({ subscriptions: { update: stripeUpdate } }),
  assertStripeConfigured: () => undefined,
  isStripeConfigured: () => true,
  resolvePrice: vi.fn(),
  isFoundingWindowOpen: () => false,
}));

vi.mock('../services/subscriptions/state.service', () => ({
  subscriptionStateService: {
    getCurrent: (...args: unknown[]) => getCurrent(...args),
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

async function loadService() {
  vi.resetModules();
  return (await import('../services/subscriptions/checkout.service')).checkoutService;
}

beforeEach(() => {
  stripeUpdate.mockReset();
  applyState.mockReset();
  getCurrent.mockReset();
  invalidate.mockReset();

  stripeUpdate.mockResolvedValue({ items: { data: [{ current_period_end: PERIOD_END }] } });
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
});
