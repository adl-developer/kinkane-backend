import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The config module reads process.env at import time, so the env has to be set
// before src/lib/stripe pulls it in — hence the dynamic imports below.
const BASE_ENV = { ...process.env };

async function loadStripeLib(overrides: Record<string, string>) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../lib/stripe');
}

const PRICES = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_monthly_standard',
  STRIPE_PRICE_PLUS_ANNUAL: 'price_annual_standard',
  STRIPE_PRICE_PLUS_MONTHLY_FOUNDING: 'price_monthly_founding',
  STRIPE_PRICE_PLUS_ANNUAL_FOUNDING: 'price_annual_founding',
};

afterEach(() => {
  process.env = { ...BASE_ENV };
});

// Price resolution decides what a customer is charged. Getting it wrong either
// overcharges a Founding Member or gives away the introductory rate forever,
// and neither is visible from the outside until someone reads a statement.
describe('resolvePrice', () => {
  const OPEN = new Date('2099-01-01T00:00:00Z');
  const CLOSED = new Date('2020-01-01T00:00:00Z');

  it("uses founding prices while the buyer's window is open", async () => {
    const { resolvePrice } = await loadStripeLib(PRICES);

    expect(resolvePrice('monthly', OPEN)).toEqual({
      priceId: 'price_monthly_founding',
      standardPriceId: 'price_monthly_standard',
      isFounding: true,
    });
    expect(resolvePrice('annual', OPEN).priceId).toBe('price_annual_founding');
  });

  it('uses standard prices once the window has closed', async () => {
    const { resolvePrice } = await loadStripeLib(PRICES);

    expect(resolvePrice('monthly', CLOSED)).toEqual({
      priceId: 'price_monthly_standard',
      standardPriceId: 'price_monthly_standard',
      isFounding: false,
    });
  });

  it('uses standard prices when the buyer has no window', async () => {
    const { resolvePrice } = await loadStripeLib(PRICES);
    expect(resolvePrice('annual', null).isFounding).toBe(false);
  });

  // A half-configured promotion must not charge the wrong amount — falling back
  // to standard pricing is the only safe direction to fail in.
  it('falls back to standard pricing when a founding price is missing', async () => {
    const { resolvePrice } = await loadStripeLib({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_PRICE_PLUS_MONTHLY: 'price_monthly_standard',
      STRIPE_PRICE_PLUS_ANNUAL: 'price_annual_standard',
    });

    expect(resolvePrice('monthly', OPEN).isFounding).toBe(false);
    expect(resolvePrice('monthly', OPEN).priceId).toBe('price_monthly_standard');
  });

  it('refuses to resolve a price when Stripe is not configured', async () => {
    const { resolvePrice } = await loadStripeLib({});
    expect(() => resolvePrice('monthly', OPEN)).toThrowError(/not available/i);
  });
});

describe('planForPriceId', () => {
  let lib: typeof import('../lib/stripe');

  beforeEach(async () => {
    lib = await loadStripeLib({ ...PRICES, FOUNDING_OFFER_ENDS_AT: '2099-01-01T00:00:00Z' });
  });

  it('maps both the standard and founding price of a plan back to that plan', () => {
    expect(lib.planForPriceId('price_monthly_standard')).toBe('monthly');
    expect(lib.planForPriceId('price_monthly_founding')).toBe('monthly');
    expect(lib.planForPriceId('price_annual_standard')).toBe('annual');
    expect(lib.planForPriceId('price_annual_founding')).toBe('annual');
  });

  it('returns null for an unknown price rather than guessing a plan', () => {
    expect(lib.planForPriceId('price_something_else')).toBeNull();
    expect(lib.planForPriceId(null)).toBeNull();
  });

  it('identifies founding prices', () => {
    expect(lib.isFoundingPriceId('price_annual_founding')).toBe(true);
    expect(lib.isFoundingPriceId('price_annual_standard')).toBe(false);
    expect(lib.isFoundingPriceId(undefined)).toBe(false);
  });
});

describe('isFoundingWindowOpen', () => {
  it('closes exactly at the given instant', async () => {
    const { isFoundingWindowOpen } = await loadStripeLib(PRICES);
    const endsAt = new Date('2026-11-01T00:00:00Z');

    expect(isFoundingWindowOpen(endsAt, new Date('2026-10-31T23:59:59Z'))).toBe(true);
    expect(isFoundingWindowOpen(endsAt, new Date('2026-11-01T00:00:00Z'))).toBe(false);
    expect(isFoundingWindowOpen(null)).toBe(false);
  });
});

// The per-account window: sign-up + FOUNDING_PERIOD_MONTHS.
describe('foundingWindowEndsAt', () => {
  it('is three calendar months after sign-up by default', async () => {
    const { foundingWindowEndsAt } = await loadStripeLib(PRICES);
    expect(foundingWindowEndsAt(new Date('2026-11-09T10:00:00Z'))).toEqual(new Date('2027-02-09T10:00:00Z'));
  });

  it('clamps to the end of a shorter month', async () => {
    const { foundingWindowEndsAt } = await loadStripeLib(PRICES);
    expect(foundingWindowEndsAt(new Date('2026-11-30T00:00:00Z'))).toEqual(new Date('2027-02-28T00:00:00Z'));
  });

  it('is null when the offer is switched off', async () => {
    const { foundingWindowEndsAt } = await loadStripeLib({ ...PRICES, FOUNDING_PERIOD_MONTHS: '0' });
    expect(foundingWindowEndsAt(new Date())).toBeNull();
  });
});

describe('foundingTermOf', () => {
  it('reads the end date checkout stamped on the subscription', async () => {
    const { foundingTermOf } = await loadStripeLib({ ...PRICES, FOUNDING_OFFER_ENDS_AT: '2027-01-14T00:00:00Z' });
    expect(foundingTermOf({ metadata: { foundingEndsAt: '2027-02-09T10:00:00.000Z' } })).toEqual({
      endsAt: new Date('2027-02-09T10:00:00Z'),
      legacy: false,
    });
  });

  // Subscriptions bought under the old launch-wide rule keep that deal.
  it('treats a subscription without one as legacy, on the launch window', async () => {
    const { foundingTermOf } = await loadStripeLib({ ...PRICES, FOUNDING_OFFER_ENDS_AT: '2027-01-14T00:00:00Z' });
    expect(foundingTermOf({ metadata: { isFounding: 'true' } })).toEqual({
      endsAt: new Date('2027-01-14T00:00:00Z'),
      legacy: true,
    });
  });
});

describe('foundingAppleOfferFor', () => {
  async function load() {
    vi.resetModules();
    process.env = { ...BASE_ENV, ...PRICES };
    return import('../lib/apple-store');
  }
  const now = new Date('2026-11-09T00:00:00Z');

  // Monthly covers every renewal that starts before the window closes, the
  // same as the Stripe rollover.
  it('picks the monthly offer whose length reaches the window end', async () => {
    const { foundingAppleOfferFor } = await load();
    expect(foundingAppleOfferFor('monthly', new Date('2027-02-09T00:00:00Z'), now)).toBe('founding_monthly_3m');
    expect(foundingAppleOfferFor('monthly', new Date('2026-12-20T00:00:00Z'), now)).toBe('founding_monthly_2m');
    expect(foundingAppleOfferFor('monthly', new Date('2026-12-09T00:00:00Z'), now)).toBe('founding_monthly_1m');
    expect(foundingAppleOfferFor('monthly', new Date('2026-11-10T00:00:00Z'), now)).toBe('founding_monthly_1m');
  });

  it('gives annual buyers the one-year offer', async () => {
    const { foundingAppleOfferFor } = await load();
    expect(foundingAppleOfferFor('annual', new Date('2026-11-10T00:00:00Z'), now)).toBe('founding_annual_1y');
  });

  it('offers nothing once the window has closed', async () => {
    const { foundingAppleOfferFor } = await load();
    expect(foundingAppleOfferFor('monthly', now, now)).toBeNull();
    expect(foundingAppleOfferFor('annual', null, now)).toBeNull();
  });

  it('only counts the founding promotional offers as founding', async () => {
    const { isFoundingAppleOffer } = await load();
    expect(isFoundingAppleOffer({ offerType: 2, offerIdentifier: 'founding_monthly_2m' })).toBe(true);
    expect(isFoundingAppleOffer({ offerType: 2, offerIdentifier: 'founding_annual_1y' })).toBe(true);
    expect(isFoundingAppleOffer({ offerType: 1, offerIdentifier: 'founding_monthly_2m' })).toBe(false);
    expect(isFoundingAppleOffer({ offerType: 2, offerIdentifier: 'winback_50' })).toBe(false);
    expect(isFoundingAppleOffer({})).toBe(false);
  });
});

// StoreKit rejects the purchase outright if a single byte of this is off.
describe('signAppleOffer', () => {
  it("signs Apple's U+2063-joined payload with the In-App Purchase key", async () => {
    const crypto = await import('crypto');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    vi.resetModules();
    process.env = {
      ...BASE_ENV,
      APPLE_IAP_ISSUER_ID: 'issuer',
      APPLE_IAP_KEY_ID: 'KEY123',
      APPLE_IAP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'),
      APPLE_BUNDLE_ID: 'app.kinkane',
      APPLE_PRODUCT_PLUS_MONTHLY: 'plus.monthly',
      APPLE_PRODUCT_PLUS_ANNUAL: 'plus.annual',
    };
    const { signAppleOffer } = await import('../lib/apple-store');

    const token = 'ABCDEF12-3456-4789-8ABC-DEF012345678';
    const offer = signAppleOffer('plus.monthly', 'founding_monthly_3m', token);
    const payload = ['app.kinkane', 'KEY123', 'plus.monthly', 'founding_monthly_3m', token.toLowerCase(), offer.nonce, offer.timestamp].join('⁣');

    expect(offer.keyId).toBe('KEY123');
    expect(crypto.verify('sha256', Buffer.from(payload), publicKey, Buffer.from(offer.signature, 'base64'))).toBe(true);
  });
});
