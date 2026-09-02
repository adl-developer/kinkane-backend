import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * The pricing rules decide what a real person is charged, and they are driven
 * entirely by operator-editable environment variables. Every branch below is a
 * way to overcharge someone, undercharge ourselves, or hand Stripe an amount it
 * refuses — none of which is visible from the outside until money has moved.
 *
 * The config module reads process.env at import time, so each case re-imports
 * the module under its own env — the same pattern as subscription-pricing.test.ts.
 */
const BASE_ENV = { ...process.env };

async function loadPricing(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../services/commerce/pricing');
}

async function loadPricingModule(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../services/commerce/gardners-countries');
}

async function loadMoney(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../lib/money');
}

const RATES = {
  SUPPORTED_CURRENCIES: 'USD,GBP,EUR,JPY',
  DEFAULT_CURRENCY: 'USD',
  FX_RATES_FROM_GBP: 'USD:1.25,EUR:1.20,JPY:190',
  FX_BUFFER_PERCENT: '0',
};

afterEach(() => {
  process.env = { ...BASE_ENV };
});

describe('minor units', () => {
  it('treats zero-decimal currencies as having no minor unit', async () => {
    const { minorUnitsPerMajor, decimalPlaces } = await loadMoney();

    expect(minorUnitsPerMajor('JPY')).toBe(1);
    expect(decimalPlaces('JPY')).toBe(0);
    expect(minorUnitsPerMajor('USD')).toBe(100);
    expect(minorUnitsPerMajor('KWD')).toBe(1000);
  });

  // Stripe only supports two decimals of precision even for currencies that
  // have three, and rejects anything that isn't a multiple of 100.
  it('rounds three-decimal currencies up to a Stripe-acceptable amount', async () => {
    const { toStripeAmount } = await loadMoney();

    expect(toStripeAmount(1234, 'KWD')).toBe(1300);
    expect(toStripeAmount(1200, 'KWD')).toBe(1200);
    expect(toStripeAmount(1234, 'USD')).toBe(1234);
  });
});

describe('convertFromGbpPence', () => {
  it('leaves GBP untouched rather than round-tripping it through a rate', async () => {
    const { convertFromGbpPence } = await loadMoney();
    expect(convertFromGbpPence(1499, 'GBP', 1, 5)).toBe(1499);
  });

  it('converts into the target currency minor unit', async () => {
    const { convertFromGbpPence } = await loadMoney();
    // £14.99 at 1.25 = $18.7375 -> 1874 cents (rounded up)
    expect(convertFromGbpPence(1499, 'USD', 1.25)).toBe(1874);
  });

  it('has no minor unit for JPY', async () => {
    const { convertFromGbpPence } = await loadMoney();
    // £14.99 at 190 = ¥2848.1 -> ¥2849, not ¥284810
    expect(convertFromGbpPence(1499, 'JPY', 190)).toBe(2849);
  });

  // Rounding down loses money on every line of every order.
  it('always rounds up', async () => {
    const { convertFromGbpPence } = await loadMoney();
    expect(convertFromGbpPence(100, 'USD', 1.001)).toBe(101);
  });

  it('applies the configured buffer on top of the rate', async () => {
    const { convertFromGbpPence } = await loadMoney();
    // £10 at 1.25 = $12.50; +4% = $13.00
    expect(convertFromGbpPence(1000, 'USD', 1.25, 4)).toBe(1300);
  });

  it('refuses to convert at a nonsense rate instead of inventing a price', async () => {
    const { convertFromGbpPence } = await loadMoney();
    expect(() => convertFromGbpPence(1000, 'USD', 0)).toThrow(/no usable exchange rate/i);
  });
});

describe('resolveCurrency', () => {
  it('prefers an explicit supported request', async () => {
    const { resolveCurrency } = await loadPricing(RATES);
    expect(resolveCurrency({ requested: 'eur', countryCode: 'GB' })).toBe('EUR');
  });

  // A stale client asking for something we've stopped supporting should still
  // see a priced cart, not an error.
  it('ignores an unsupported request and falls through to the country', async () => {
    const { resolveCurrency } = await loadPricing({
      ...RATES,
      CURRENCY_BY_COUNTRY: 'GB:GBP',
    });
    expect(resolveCurrency({ requested: 'XXX', countryCode: 'GB' })).toBe('GBP');
  });

  it('defaults to USD when the country is unknown or unmapped', async () => {
    const { resolveCurrency } = await loadPricing({ ...RATES, CURRENCY_BY_COUNTRY: 'GB:GBP' });
    expect(resolveCurrency({ countryCode: 'BR' })).toBe('USD');
    expect(resolveCurrency({})).toBe('USD');
  });

  it('does not map a country to a currency it cannot present', async () => {
    const { resolveCurrency } = await loadPricing({
      ...RATES,
      SUPPORTED_CURRENCIES: 'USD,GBP',
      CURRENCY_BY_COUNTRY: 'DE:EUR',
    });
    expect(resolveCurrency({ countryCode: 'DE' })).toBe('USD');
  });
});

describe('fxRateFor', () => {
  it('is always 1 for GBP, the currency everything originates in', async () => {
    const { fxRateFor } = await loadPricing(RATES);
    expect(fxRateFor('GBP')).toBe(1);
  });

  // Guessing here would mean charging someone a number nobody chose.
  it('throws 503 for a currency with no configured rate', async () => {
    const { fxRateFor } = await loadPricing({ ...RATES, FX_RATES_FROM_GBP: 'USD:1.25' });
    expect(() => fxRateFor('EUR')).toThrow(/no exchange rate configured/i);
  });
});

describe('quoteShipping', () => {
  const SHIPPING = {
    ...RATES,
    SHIPPING_RATES: 'GB:299,EU:699,US:899,ROW:1199',
    SHIPPING_PER_ITEM_GBP_PENCE: '0',
  };

  it('prefers an exact country rule', async () => {
    const { quoteShipping } = await loadPricing(SHIPPING);
    expect(quoteShipping({ countryCode: 'GB', itemCount: 1, subtotalGbpPence: 1000 })).toEqual({
      gbpPence: 299,
      rule: 'GB',
    });
  });

  it('falls back to the EU bucket for member states with no rule of their own', async () => {
    const { quoteShipping } = await loadPricing(SHIPPING);
    expect(quoteShipping({ countryCode: 'DE', itemCount: 1, subtotalGbpPence: 1000 }).rule).toBe('EU');
  });

  it('falls back to ROW for everywhere else', async () => {
    const { quoteShipping } = await loadPricing(SHIPPING);
    expect(quoteShipping({ countryCode: 'GH', itemCount: 1, subtotalGbpPence: 1000 })).toEqual({
      gbpPence: 1199,
      rule: 'ROW',
    });
  });

  it('adds the per-item charge on top of the base rate', async () => {
    const { quoteShipping } = await loadPricing({
      ...SHIPPING,
      SHIPPING_PER_ITEM_GBP_PENCE: '50',
    });
    expect(
      quoteShipping({ countryCode: 'GB', itemCount: 3, subtotalGbpPence: 5000 }).gbpPence,
    ).toBe(299 + 150);
  });

  it('applies the free-shipping threshold ahead of every other rule', async () => {
    const { quoteShipping } = await loadPricing({
      ...SHIPPING,
      SHIPPING_FREE_THRESHOLD_GBP_PENCE: '4000',
      SHIPPING_FREE_THRESHOLD_COUNTRIES: '',
    });
    expect(quoteShipping({ countryCode: 'GH', itemCount: 5, subtotalGbpPence: 4000 })).toEqual({
      gbpPence: 0,
      rule: 'FREE_THRESHOLD',
    });
  });

  // A £40 basket to Ghana was giving away a parcel that costs £33 to send. The
  // threshold is a promotion, and a promotion that costs more than the margin
  // on what it is promoting is not one.
  it('honours the free-shipping threshold only where it is configured', async () => {
    const { quoteShipping } = await loadPricing({
      ...SHIPPING,
      SHIPPING_FREE_THRESHOLD_GBP_PENCE: '4000',
      SHIPPING_FREE_THRESHOLD_COUNTRIES: 'GB',
    });

    expect(quoteShipping({ countryCode: 'GB', itemCount: 5, subtotalGbpPence: 4000 })).toEqual({
      gbpPence: 0,
      rule: 'FREE_THRESHOLD',
    });
    expect(quoteShipping({ countryCode: 'GH', itemCount: 5, subtotalGbpPence: 4000 })).toEqual({
      gbpPence: 1199,
      rule: 'ROW',
    });
  });

  // An empty list is the way back to the old behaviour, so it must keep working.
  it('treats an empty country list as "everywhere"', async () => {
    const { quoteShipping } = await loadPricing({
      ...SHIPPING,
      SHIPPING_FREE_THRESHOLD_GBP_PENCE: '4000',
      SHIPPING_FREE_THRESHOLD_COUNTRIES: '',
    });
    expect(
      quoteShipping({ countryCode: 'AU', itemCount: 1, subtotalGbpPence: 9999 }).rule,
    ).toBe('FREE_THRESHOLD');
  });

  // Shipping free by accident to an arbitrary country is worse than a 503 the
  // first time someone ships somewhere new.
  it('refuses to quote rather than shipping free when ROW is missing', async () => {
    const { quoteShipping } = await loadPricing({ ...RATES, SHIPPING_RATES: 'GB:299' });
    expect(() =>
      quoteShipping({ countryCode: 'GH', itemCount: 1, subtotalGbpPence: 1000 }),
    ).toThrow(/shipping is not configured/i);
  });
});

describe('quoteTax', () => {
  it('is zero for zero-rated destinations — books in the UK', async () => {
    const { quoteTax } = await loadPricing({ ...RATES, VAT_RATES: 'GB:0' });
    expect(quoteTax({ countryCode: 'GB', taxableGbpPence: 5000 })).toEqual({
      ratePercent: 0,
      gbpPence: 0,
      source: 'env',
    });
  });

  it('adds tax on top by default', async () => {
    const { quoteTax } = await loadPricing({ ...RATES, VAT_RATES: 'DE:7' });
    expect(quoteTax({ countryCode: 'DE', taxableGbpPence: 10000 }).gbpPence).toBe(700);
  });

  // Inclusive pricing means the rate comes out of our margin, not the
  // customer's total — the tax is extracted from the price, not added to it.
  it('extracts tax from the price when prices are tax-inclusive', async () => {
    const { quoteTax } = await loadPricing({
      ...RATES,
      VAT_RATES: 'DE:7',
      VAT_PRICES_INCLUDE_TAX: 'true',
    });
    // 10700 inclusive of 7% => 700 tax, 10000 net.
    expect(quoteTax({ countryCode: 'DE', taxableGbpPence: 10700 }).gbpPence).toBe(700);
  });

  it('falls back to the default rate for unlisted destinations', async () => {
    const { quoteTax } = await loadPricing({
      ...RATES,
      VAT_RATES: 'GB:0',
      VAT_DEFAULT_RATE_PERCENT: '20',
    });
    expect(quoteTax({ countryCode: 'ZZ', taxableGbpPence: 1000 }).ratePercent).toBe(20);
  });
});

describe('quoteOrder', () => {
  const ORDER_ENV = {
    ...RATES,
    SHIPPING_RATES: 'GB:299,ROW:1199',
    VAT_RATES: 'GB:0',
  };

  const lines = [
    { bookId: 1, isbn13: '9780000000001', quantity: 2, unitPriceGbpPence: 999 },
    { bookId: 2, isbn13: '9780000000002', quantity: 1, unitPriceGbpPence: 1499 },
  ];

  it('keeps both currencies on the same basket', async () => {
    const { quoteOrder } = await loadPricing(ORDER_ENV);
    const quote = quoteOrder({ lines, destinationCountry: 'GB', currency: 'GBP' });

    expect(quote.subtotalGbpPence).toBe(999 * 2 + 1499);
    expect(quote.shippingGbpPence).toBe(299);
    expect(quote.taxGbpPence).toBe(0);
    expect(quote.totalGbpPence).toBe(999 * 2 + 1499 + 299);
    // GBP presentment is the identity case, so both sides must agree exactly.
    expect(quote.subtotalMinor).toBe(quote.subtotalGbpPence);
    expect(quote.totalMinor).toBe(quote.totalGbpPence);
  });

  // A receipt whose lines don't add up to its total is the kind of thing people
  // photograph and post, so the total is summed from the converted components
  // rather than converted from the GBP total.
  it('produces a total that equals the sum of its own presented parts', async () => {
    const { quoteOrder } = await loadPricing(ORDER_ENV);
    const quote = quoteOrder({ lines, destinationCountry: 'US', currency: 'USD' });

    const summedLines = quote.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    expect(quote.subtotalMinor).toBe(summedLines);
    expect(quote.totalMinor).toBe(quote.subtotalMinor + quote.shippingMinor + quote.taxMinor);
  });

  it('pins the rate it priced at onto the quote', async () => {
    const { quoteOrder } = await loadPricing(ORDER_ENV);
    const quote = quoteOrder({ lines, destinationCountry: 'US', currency: 'USD' });

    expect(quote.fxRate).toBe(1.25);
    expect(quote.fxCapturedAt).toBeInstanceOf(Date);
    expect(quote.currency).toBe('USD');
    expect(quote.shippingRule).toBe('ROW');
  });

  it('charges per copy, not per line', async () => {
    const { quoteOrder } = await loadPricing(ORDER_ENV);
    const quote = quoteOrder({ lines, destinationCountry: 'GB', currency: 'GBP' });

    const twoCopies = quote.lines.find((line) => line.bookId === 1)!;
    expect(twoCopies.lineTotalGbpPence).toBe(999 * 2);
  });
});

describe('normalizeCountry', () => {
  it('rejects the sentinels a CDN sends for "no idea"', async () => {
    const { normalizeCountry } = await loadPricing(RATES);

    expect(normalizeCountry('gb')).toBe('GB');
    expect(normalizeCountry('XX')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry('GBR')).toBeNull();
  });
});

/**
 * Gardners' I12 constants. These are transcriptions of a legacy fixed-format
 * spec whose parser is not tolerant: an undocumented service code is rejected
 * per-line in the .ACK, and an unrecognised country name goes to manual review
 * — which the spec warns can suspend the account for repeat offenders.
 */
describe('Gardners I12 service codes', () => {
  // Spec page 11: 001 = Standard UK Delivery, 2nd Class. Confirmed by both of
  // the spec's own UK worked examples, which send "SERVICE",001.
  it('sends UK orders on the UK standard service, not an airmail code', async () => {
    const { serviceCodeFor, GARDNERS_SERVICE_CODES } = await loadPricingModule();
    expect(serviceCodeFor('GB')).toBe('001');
    expect(serviceCodeFor('gb')).toBe(GARDNERS_SERVICE_CODES.ukStandard);
  });

  // Spec page 11: 011 = Airmail Tracked. Confirmed by our own accepted orders
  // 000000043 / 000000044 to Ghana, which used "SERVICE",011.
  it('sends everything else on airmail tracked', async () => {
    const { serviceCodeFor } = await loadPricingModule();
    expect(serviceCodeFor('GH')).toBe('011');
    expect(serviceCodeFor('US')).toBe('011');
  });

  // Page 10 says tracking applies to "001, 002, 010 only"; page 11, describing
  // 011 directly, says tracking must be set to use the tracked fields. Page 11
  // wins — it is more specific, and our 011 + TRACKING,"Y" orders were accepted.
  it('keeps tracking on for airmail tracked despite the page 10 wording', async () => {
    const { supportsTracking } = await loadPricingModule();
    expect(supportsTracking('011')).toBe(true);
    expect(supportsTracking('001')).toBe(true);
    expect(supportsTracking('015')).toBe(false); // BFPO
  });
});

describe('Gardners I12 country names', () => {
  it('uses the two names we have positive evidence for', async () => {
    const { gardnersCountryName, VERIFIED_COUNTRY_CODES } = await loadPricingModule();
    // Spec's own worked examples.
    expect(gardnersCountryName('GB')).toBe('UNITED KINGDOM');
    // Accepted by Gardners in orders 000000043 / 000000044.
    expect(gardnersCountryName('GH')).toBe('GHANA');
    expect(VERIFIED_COUNTRY_CODES.has('GH')).toBe(true);
  });

  it('reports an unmapped country rather than inventing a name for it', async () => {
    const { gardnersCountryName, isDeliverableCountry } = await loadPricingModule();
    expect(gardnersCountryName('ZZ')).toBeNull();
    expect(isDeliverableCountry('ZZ')).toBe(false);
    expect(isDeliverableCountry('GH')).toBe(true);
  });

  // The real list has to be requested from Gardners; this is what lets it be
  // applied without a deploy once it arrives.
  it('lets an operator override a guessed name from the environment', async () => {
    const { gardnersCountryName } = await loadPricingModule({
      GARDNERS_COUNTRY_NAMES_EXTRA: 'US:UNITED STATES OF AMERICA,ZZ:NOWHERE',
    });
    expect(gardnersCountryName('US')).toBe('UNITED STATES OF AMERICA');
    expect(gardnersCountryName('ZZ')).toBe('NOWHERE');
  });

  it('names every country in the style the confirmed entries use', async () => {
    const { deliverableCountryCodes, gardnersCountryName } = await loadPricingModule();
    for (const code of deliverableCountryCodes()) {
      const name = gardnersCountryName(code)!;
      // Upper case, no abbreviations, no leading/trailing space — the spec is
      // explicit that abbreviations are never acceptable.
      expect(name).toBe(name.toUpperCase().trim());
      expect(name).not.toMatch(/\./);
    }
  });
});
