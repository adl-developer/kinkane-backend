import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The guards that keep Stripe and Apple from writing over each other.
 *
 * A member can move between the two — a web subscription ends and they buy in
 * the iOS app, or the reverse. The old provider keeps sending events for a
 * while (the final deletion, a late retry), and acting on those would revoke
 * Plus that the *other* provider is billing for. Each test here is one way
 * that would happen if a guard were dropped.
 */

const stripeRetrieve = vi.fn();
const applyState = vi.fn();
const get = vi.fn();
const getCurrent = vi.fn();
const getByStripeCustomerId = vi.fn();
const invalidate = vi.fn();

vi.mock('../lib/stripe', () => ({
  stripe: () => ({ subscriptions: { retrieve: stripeRetrieve } }),
  assertStripeConfigured: () => undefined,
  isStripeConfigured: () => true,
  resolvePrice: () => ({ priceId: 'price_monthly', standardPriceId: 'price_monthly', isFounding: false }),
  planForPriceId: () => 'monthly',
  isFoundingPriceId: () => false,
  isFoundingWindowOpen: () => false,
}));

vi.mock('../services/subscriptions/state.service', () => ({
  subscriptionStateService: {
    applyState: (...a: unknown[]) => applyState(...a),
    get: (...a: unknown[]) => get(...a),
    getCurrent: (...a: unknown[]) => getCurrent(...a),
    getByStripeCustomerId: (...a: unknown[]) => getByStripeCustomerId(...a),
  },
}));

vi.mock('../services/subscriptions/entitlements.service', () => ({
  entitlementsService: { invalidate: (...a: unknown[]) => invalidate(...a) },
}));

vi.mock('../services/subscriptions/schedules.service', () => ({
  schedulesService: { scheduleFoundingRollover: vi.fn(), releaseFrom: vi.fn() },
  scheduleIdOf: () => null,
}));

vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/commerce/order-webhooks.service', () => ({ orderWebhooksService: {} }));
vi.mock('../services/payments.service', () => ({ paymentsService: {} }));

/** Billed by Apple now, with the id of a Stripe subscription that has ended. */
const APPLE_BILLED = {
  userId: 7,
  tier: 'plus',
  status: 'active',
  plan: 'monthly',
  priceId: 'com.kinkane.plus.monthly',
  cancelAtPeriodEnd: false,
  pendingPlan: null,
  isFoundingMember: false,
  billingProvider: 'apple',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_old',
  appleOriginalTransactionId: '2000000111111111',
};

const STRIPE_SUBSCRIPTION = {
  id: 'sub_old',
  customer: 'cus_1',
  status: 'canceled',
  cancel_at_period_end: false,
  metadata: {},
  items: { data: [{ current_period_end: 1790000000, price: { id: 'price_monthly' } }] },
};

const event = (type: string, object: unknown) => ({ id: 'evt_1', type, data: { object } });

async function webhooks() {
  vi.resetModules();
  return (await import('../services/subscriptions/webhooks.service')).webhooksService;
}

beforeEach(() => {
  for (const fn of [stripeRetrieve, applyState, get, getCurrent, getByStripeCustomerId, invalidate]) {
    fn.mockReset();
  }
  getByStripeCustomerId.mockResolvedValue(APPLE_BILLED);
  get.mockResolvedValue(APPLE_BILLED);
  applyState.mockImplementation(async (_u: number, next: object) => ({ ...APPLE_BILLED, ...next }));
});

describe('Stripe webhooks for a member now billed by Apple', () => {
  it('ignore the old Stripe subscription ending', async () => {
    const service = await webhooks();
    await service.handleEvent(event('customer.subscription.deleted', STRIPE_SUBSCRIPTION) as never);
    expect(applyState).not.toHaveBeenCalled();
  });

  it('ignore a late change to the old Stripe subscription', async () => {
    const service = await webhooks();
    await service.handleEvent(event('customer.subscription.updated', STRIPE_SUBSCRIPTION) as never);
    expect(applyState).not.toHaveBeenCalled();
  });

  it('ignore a late invoice without touching Stripe or the row', async () => {
    const service = await webhooks();
    await service.handleEvent(
      event('invoice.paid', { id: 'in_1', customer: 'cus_1', subscription: 'sub_old', metadata: {} }) as never,
    );
    expect(stripeRetrieve).not.toHaveBeenCalled();
    expect(applyState).not.toHaveBeenCalled();
  });
});

describe('Stripe webhooks for an unlabelled Stripe member', () => {
  // Rows from before billing_provider existed. Any Stripe write labels them,
  // so the Apple guard and reconciliation see them as Stripe from then on.
  it('label the row as Stripe-billed', async () => {
    const unlabelled = { ...APPLE_BILLED, billingProvider: null, stripeSubscriptionId: 'sub_live' };
    getByStripeCustomerId.mockResolvedValue(unlabelled);
    get.mockResolvedValue(unlabelled);
    const service = await webhooks();

    await service.handleEvent(
      event('customer.subscription.updated', { ...STRIPE_SUBSCRIPTION, id: 'sub_live', status: 'active' }) as never,
    );

    expect(applyState).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ billingProvider: 'stripe', tier: 'plus' }),
      expect.anything(),
    );
  });
});

describe('Stripe checkout for a member billed by Apple', () => {
  async function checkout() {
    vi.resetModules();
    return (await import('../services/subscriptions/checkout.service')).checkoutService;
  }

  it('is refused while the App Store subscription is live — no double billing', async () => {
    getCurrent.mockResolvedValue(APPLE_BILLED);
    const service = await checkout();

    await expect(service.createCheckoutSession(7, 'monthly')).rejects.toMatchObject({
      statusCode: 409,
      code: 'MANAGED_BY_APPLE',
    });
  });

  it('is allowed once the App Store subscription has ended', async () => {
    getCurrent.mockResolvedValue({ ...APPLE_BILLED, tier: 'free', status: 'cancelled' });
    const service = await checkout();

    // Gets past the Apple guard and on to creating the Stripe customer, which
    // this test's mocks don't provide — so any failure here must not be ours.
    await expect(service.createCheckoutSession(7, 'monthly')).rejects.not.toMatchObject({
      code: 'MANAGED_BY_APPLE',
    });
  });
});
