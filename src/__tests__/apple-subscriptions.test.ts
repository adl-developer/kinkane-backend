import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AppleSubscriptionSnapshot } from '../lib/apple-store';

/**
 * Kinkané Plus bought in the iOS app.
 *
 * The expensive mistakes here are all about *whose* Plus a purchase switches
 * on and *who is allowed to write* the subscription row:
 *
 *   - one App Store purchase unlocking Plus on several Kinkané accounts;
 *   - an Apple write overwriting someone who already pays through Stripe;
 *   - restoring an old, expired purchase ending a running free trial;
 *   - trusting what a notification body claims instead of asking Apple.
 *
 * Apple's API, the state writer and the database are mocked — there is no App
 * Store account in CI, and what matters is the decision taken on each answer.
 */

const getSubscription = vi.fn();
const applyState = vi.fn();
const get = vi.fn();
const getCurrent = vi.fn();
const getByAppleOriginalTransactionId = vi.fn();
const invalidate = vi.fn();
const enqueueEmail = vi.fn();
const eventsInserted: unknown[] = [];
let claimResult: unknown[] = [{ id: 'n-1' }];

vi.mock('../lib/apple-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/apple-store')>();
  return { ...actual, appleStore: { getSubscription: (...a: unknown[]) => getSubscription(...a) } };
});

vi.mock('../services/subscriptions/state.service', () => ({
  subscriptionStateService: {
    applyState: (...a: unknown[]) => applyState(...a),
    get: (...a: unknown[]) => get(...a),
    getCurrent: (...a: unknown[]) => getCurrent(...a),
    getByAppleOriginalTransactionId: (...a: unknown[]) => getByAppleOriginalTransactionId(...a),
  },
}));

vi.mock('../services/subscriptions/entitlements.service', () => ({
  entitlementsService: { invalidate: (...a: unknown[]) => invalidate(...a) },
}));

vi.mock('../lib/email-queue', () => ({
  enqueueEmail: (...a: unknown[]) => enqueueEmail(...a),
}));

vi.mock('../db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: async () => claimResult }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ email: 'reader@example.com', name: 'Ada' }] }),
      }),
    }),
  },
}));

const MONTHLY = 'com.kinkane.plus.monthly';
const ANNUAL = 'com.kinkane.plus.annual';
const OTID = '2000000111111111';
const EXPIRES = Date.parse('2026-11-05T00:00:00Z');

/** A user on the in-app trial, never paid. */
const TRIALING = {
  userId: 7,
  tier: 'plus',
  status: 'trialing',
  plan: null,
  cancelAtPeriodEnd: false,
  billingProvider: null,
  stripeSubscriptionId: null,
  appleOriginalTransactionId: null,
};

function snapshot(overrides: {
  status?: number;
  productId?: string;
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  appAccountToken?: string;
  revocationDate?: number;
} = {}): AppleSubscriptionSnapshot {
  return {
    environment: 'Production',
    status: overrides.status ?? 1,
    transaction: {
      transactionId: '2000000999999999',
      originalTransactionId: OTID,
      bundleId: 'com.kinkane.app',
      productId: overrides.productId ?? MONTHLY,
      expiresDate: EXPIRES,
      price: 8990,
      currency: 'USD',
      appAccountToken: overrides.appAccountToken,
      revocationDate: overrides.revocationDate,
    },
    renewal: {
      originalTransactionId: OTID,
      autoRenewStatus: overrides.autoRenewStatus ?? 1,
      autoRenewProductId: overrides.autoRenewProductId ?? overrides.productId ?? MONTHLY,
    },
  };
}

/** A JWS-shaped string with an unsigned payload — enough for decodeJws. */
function jws(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

async function load() {
  vi.resetModules();
  process.env.APPLE_IAP_ISSUER_ID = 'issuer';
  process.env.APPLE_IAP_KEY_ID = 'KEY123';
  process.env.APPLE_IAP_PRIVATE_KEY = 'unused-in-tests';
  process.env.APPLE_BUNDLE_ID = 'com.kinkane.app';
  process.env.APPLE_PRODUCT_PLUS_MONTHLY = MONTHLY;
  process.env.APPLE_PRODUCT_PLUS_ANNUAL = ANNUAL;
  const service = (await import('../services/subscriptions/apple.service')).appleSubscriptionsService;
  const store = await import('../lib/apple-store');
  return { service, store };
}

beforeEach(() => {
  for (const fn of [getSubscription, applyState, get, getCurrent, getByAppleOriginalTransactionId, invalidate, enqueueEmail]) {
    fn.mockReset();
  }
  eventsInserted.length = 0;
  claimResult = [{ id: 'n-1' }];
  enqueueEmail.mockResolvedValue(undefined);
  getByAppleOriginalTransactionId.mockResolvedValue(null);
  get.mockResolvedValue(TRIALING);
  applyState.mockImplementation(async (userId: number, next: Record<string, unknown>, opts: { inSameTx?: (tx: unknown, row: unknown) => Promise<void> }) => {
    const row = { ...TRIALING, userId, ...next };
    await opts.inSameTx?.({ insert: () => ({ values: async (v: unknown) => { eventsInserted.push(...(Array.isArray(v) ? v : [v])); } }) }, row);
    return row;
  });
});

const events = () => (eventsInserted as { event: string }[]).map((e) => e.event);
const written = () => applyState.mock.calls[0]?.[1] as Record<string, unknown>;

describe('verifyPurchase', () => {
  it('links the App Store subscription to the user and switches Plus on', async () => {
    getSubscription.mockResolvedValue(snapshot());
    const { service } = await load();

    await service.verifyPurchase(7, '2000000999999999');

    expect(applyState).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        tier: 'plus',
        status: 'active',
        plan: 'monthly',
        billingProvider: 'apple',
        appleOriginalTransactionId: OTID,
        currentPeriodEnd: new Date(EXPIRES),
        cancelAtPeriodEnd: false,
      }),
      expect.objectContaining({ reason: 'apple_verified' }),
    );
    expect(events()).toEqual(['converted']);
    expect((eventsInserted[0] as { amountCents: number }).amountCents).toBe(899);
    expect(invalidate).toHaveBeenCalledWith(7);
    expect(enqueueEmail).toHaveBeenCalledWith('subscription-confirmed', expect.anything());
  });

  // A second verify of the same purchase (app relaunch, restore) is a no-op for
  // the audit trail and the inbox.
  it('records no second conversion when the purchase is verified again', async () => {
    getSubscription.mockResolvedValue(snapshot());
    const bound = { ...TRIALING, tier: 'plus', status: 'active', plan: 'monthly', billingProvider: 'apple', appleOriginalTransactionId: OTID };
    getByAppleOriginalTransactionId.mockResolvedValue(bound);
    const { service } = await load();

    await service.verifyPurchase(7, '2000000999999999');

    expect(events()).toEqual([]);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('refuses a subscription already linked to another account', async () => {
    getSubscription.mockResolvedValue(snapshot());
    getByAppleOriginalTransactionId.mockResolvedValue({ ...TRIALING, userId: 99, appleOriginalTransactionId: OTID });
    const { service } = await load();

    await expect(service.verifyPurchase(7, '2000000999999999')).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPLE_SUBSCRIPTION_IN_USE',
    });
    expect(applyState).not.toHaveBeenCalled();
  });

  it('refuses a purchase made while signed in to a different Kinkané account', async () => {
    const { store } = await load();
    getSubscription.mockResolvedValue(snapshot({ appAccountToken: store.appAccountTokenFor(99) }));
    const { service } = await load();

    await expect(service.verifyPurchase(7, '2000000999999999')).rejects.toMatchObject({
      code: 'APPLE_ACCOUNT_MISMATCH',
    });
    expect(applyState).not.toHaveBeenCalled();
  });

  it('accepts a purchase carrying this user’s own account token', async () => {
    const { store } = await load();
    getSubscription.mockResolvedValue(snapshot({ appAccountToken: store.appAccountTokenFor(7).toUpperCase() }));
    const { service } = await load();

    await service.verifyPurchase(7, '2000000999999999');
    expect(applyState).toHaveBeenCalled();
  });

  // Paying twice needs a human (and an Apple refund) — never a silent overwrite.
  it('leaves an active Stripe subscriber untouched', async () => {
    getSubscription.mockResolvedValue(snapshot());
    get.mockResolvedValue({ ...TRIALING, tier: 'plus', status: 'active', billingProvider: 'stripe', stripeSubscriptionId: 'sub_1' });
    const { service } = await load();

    await expect(service.verifyPurchase(7, '2000000999999999')).rejects.toMatchObject({
      code: 'STRIPE_SUBSCRIPTION_ACTIVE',
    });
    expect(applyState).not.toHaveBeenCalled();
  });

  // Moving from an ended web subscription to the App Store is fine.
  it('takes over from a Stripe subscription that has already ended', async () => {
    getSubscription.mockResolvedValue(snapshot());
    get.mockResolvedValue({ ...TRIALING, tier: 'free', status: 'cancelled', billingProvider: 'stripe', stripeSubscriptionId: 'sub_old' });
    const { service } = await load();

    await service.verifyPurchase(7, '2000000999999999');
    expect(written()).toMatchObject({ billingProvider: 'apple', tier: 'plus' });
  });

  it('does not let an expired purchase end a running trial', async () => {
    getSubscription.mockResolvedValue(snapshot({ status: 2 }));
    const { service } = await load();

    await expect(service.verifyPurchase(7, '2000000999999999')).rejects.toMatchObject({
      code: 'APPLE_SUBSCRIPTION_INACTIVE',
    });
    expect(applyState).not.toHaveBeenCalled();
  });

  it('404s when Apple has no such Plus transaction', async () => {
    getSubscription.mockResolvedValue(null);
    const { service } = await load();

    await expect(service.verifyPurchase(7, '1')).rejects.toMatchObject({
      statusCode: 404,
      code: 'APPLE_TRANSACTION_NOT_FOUND',
    });
  });
});

describe('state mapping', () => {
  const bound = { ...TRIALING, tier: 'plus', status: 'active', plan: 'monthly', billingProvider: 'apple', appleOriginalTransactionId: OTID };

  beforeEach(() => getByAppleOriginalTransactionId.mockResolvedValue(bound));

  it('turning off auto-renew keeps Plus until the period ends', async () => {
    getSubscription.mockResolvedValue(snapshot({ autoRenewStatus: 0 }));
    const { service } = await load();

    await service.verifyPurchase(7, OTID);

    expect(written()).toMatchObject({ tier: 'plus', status: 'active', cancelAtPeriodEnd: true });
    expect(events()).toEqual(['cancelled']);
    expect(enqueueEmail).toHaveBeenCalledWith('subscription-cancelled', expect.anything());
  });

  it('a grace period keeps Plus; billing retry without one does not', async () => {
    const { store } = await load();
    const t = snapshot().transaction;
    expect(store.mapAppleStatus(4, t)).toEqual({ status: 'past_due', tier: 'plus' });
    expect(store.mapAppleStatus(3, t)).toEqual({ status: 'past_due', tier: 'free' });
    expect(store.mapAppleStatus(2, t)).toEqual({ status: 'cancelled', tier: 'free' });
    expect(store.mapAppleStatus(5, t)).toEqual({ status: 'cancelled', tier: 'free' });
  });

  it('a refunded transaction loses Plus even if Apple still says active', async () => {
    const { store } = await load();
    expect(store.mapAppleStatus(1, snapshot({ revocationDate: Date.now() }).transaction)).toEqual({
      status: 'cancelled',
      tier: 'free',
    });
  });

  it('shows a plan change scheduled for the next renewal as pending', async () => {
    getSubscription.mockResolvedValue(snapshot({ autoRenewProductId: ANNUAL }));
    const { service } = await load();

    await service.verifyPurchase(7, OTID);
    expect(written()).toMatchObject({ plan: 'monthly', pendingPlan: 'annual' });
  });
});

describe('handleNotification', () => {
  const bound = { ...TRIALING, tier: 'plus', status: 'active', plan: 'monthly', billingProvider: 'apple', appleOriginalTransactionId: OTID };

  function notification(type: string, subtype?: string) {
    return jws({
      notificationType: type,
      subtype,
      notificationUUID: 'n-1',
      data: {
        bundleId: 'com.kinkane.app',
        environment: 'Production',
        signedTransactionInfo: jws(snapshot().transaction),
      },
    });
  }

  // The body is untrusted: whatever it claims, the state written is Apple's answer.
  it('writes what Apple reports, not what the notification claims', async () => {
    getByAppleOriginalTransactionId.mockResolvedValue(bound);
    getSubscription.mockResolvedValue(snapshot({ status: 1 }));
    const { service } = await load();

    await service.handleNotification(notification('EXPIRED', 'VOLUNTARY'));

    expect(getSubscription).toHaveBeenCalledWith('2000000999999999');
    expect(written()).toMatchObject({ tier: 'plus', status: 'active' });
  });

  it('records a renewal with its amount', async () => {
    getByAppleOriginalTransactionId.mockResolvedValue(bound);
    getSubscription.mockResolvedValue(snapshot());
    const { service } = await load();

    await service.handleNotification(notification('DID_RENEW'));

    expect(events()).toEqual(['renewed']);
    expect(eventsInserted[0]).toMatchObject({ amountCents: 899, currency: 'USD', appleNotificationId: 'n-1' });
    expect(applyState.mock.calls[0][2]).toMatchObject({ reason: 'apple_notification', sourceEventId: 'n-1' });
  });

  it('switches Plus off when the subscription has expired', async () => {
    getByAppleOriginalTransactionId.mockResolvedValue(bound);
    getSubscription.mockResolvedValue(snapshot({ status: 2 }));
    const { service } = await load();

    await service.handleNotification(notification('EXPIRED', 'VOLUNTARY'));

    expect(written()).toMatchObject({ tier: 'free', status: 'cancelled' });
    expect(events()).toEqual(['expired']);
  });

  // SUBSCRIBED usually beats the app's verify call. Nobody to credit yet.
  it('skips a subscription no account has verified yet', async () => {
    getSubscription.mockResolvedValue(snapshot());
    const { service } = await load();

    await service.handleNotification(notification('SUBSCRIBED', 'INITIAL_BUY'));
    expect(applyState).not.toHaveBeenCalled();
  });

  it('skips a redelivered notification without calling Apple', async () => {
    claimResult = [];
    const { service } = await load();

    const result = await service.handleNotification(notification('DID_RENEW'));

    expect(result.duplicate).toBe(true);
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it('ignores a notification for another app', async () => {
    const { service } = await load();
    await service.handleNotification(
      jws({ notificationType: 'DID_RENEW', notificationUUID: 'n-2', data: { bundleId: 'com.other.app' } }),
    );
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a notification', async () => {
    const { service } = await load();
    await expect(service.handleNotification('not-a-jws')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('appAccountTokenFor', () => {
  it('is a stable v4 UUID, different for every user', async () => {
    const { store } = await load();
    const a = store.appAccountTokenFor(7);

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(store.appAccountTokenFor(7)).toBe(a);
    expect(store.appAccountTokenFor(8)).not.toBe(a);
  });
});
