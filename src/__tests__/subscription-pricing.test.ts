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
  it('uses founding prices while the launch window is open', async () => {
    const { resolvePrice } = await loadStripeLib({
      ...PRICES,
      FOUNDING_OFFER_ENDS_AT: '2099-01-01T00:00:00Z',
    });

    expect(resolvePrice('monthly')).toEqual({
      priceId: 'price_monthly_founding',
      standardPriceId: 'price_monthly_standard',
      isFounding: true,
    });
    expect(resolvePrice('annual').priceId).toBe('price_annual_founding');
  });

  it('uses standard prices once the window has closed', async () => {
    const { resolvePrice } = await loadStripeLib({
      ...PRICES,
      FOUNDING_OFFER_ENDS_AT: '2020-01-01T00:00:00Z',
    });

    expect(resolvePrice('monthly')).toEqual({
      priceId: 'price_monthly_standard',
      standardPriceId: 'price_monthly_standard',
      isFounding: false,
    });
  });

  it('uses standard prices when no window is configured at all', async () => {
    const { resolvePrice } = await loadStripeLib(PRICES);
    expect(resolvePrice('annual').isFounding).toBe(false);
  });

  // A half-configured promotion must not charge the wrong amount — falling back
  // to standard pricing is the only safe direction to fail in.
  it('falls back to standard pricing when a founding price is missing', async () => {
    const { resolvePrice } = await loadStripeLib({
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_PRICE_PLUS_MONTHLY: 'price_monthly_standard',
      STRIPE_PRICE_PLUS_ANNUAL: 'price_annual_standard',
      FOUNDING_OFFER_ENDS_AT: '2099-01-01T00:00:00Z',
    });

    expect(resolvePrice('monthly').isFounding).toBe(false);
    expect(resolvePrice('monthly').priceId).toBe('price_monthly_standard');
  });

  it('refuses to resolve a price when Stripe is not configured', async () => {
    const { resolvePrice } = await loadStripeLib({});
    expect(() => resolvePrice('monthly')).toThrowError(/not available/i);
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
  it('closes exactly at the configured instant', async () => {
    const { isFoundingWindowOpen } = await loadStripeLib({
      ...PRICES,
      FOUNDING_OFFER_ENDS_AT: '2026-11-01T00:00:00Z',
    });

    expect(isFoundingWindowOpen(new Date('2026-10-31T23:59:59Z'))).toBe(true);
    expect(isFoundingWindowOpen(new Date('2026-11-01T00:00:00Z'))).toBe(false);
    expect(isFoundingWindowOpen(new Date('2026-11-01T00:00:01Z'))).toBe(false);
  });
});
