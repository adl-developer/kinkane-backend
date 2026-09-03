import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * Which delivery options a destination gets offered, and which one is picked
 * when the client does not choose. Both decide what a buyer is charged, and
 * both depend on rate coverage that is genuinely uneven between countries.
 *
 * The rate card is stubbed rather than read from a database — these are
 * decisions about a card, not about a query.
 */
const BASE_ENV = { ...process.env };

const RATE_ENV = {
  SUPPORTED_CURRENCIES: 'GBP,USD',
  DEFAULT_CURRENCY: 'GBP',
  FX_RATES_FROM_GBP: 'USD:1.25',
  FX_BUFFER_PERCENT: '0',
  SHIPPING_USE_RATE_TABLE: 'true',
  SHIPPING_RATES: 'GB:299,ROW:1199',
  SHIPPING_FULFILMENT_FIRST_ITEM_PENCE: '70',
  SHIPPING_FULFILMENT_EXTRA_ITEM_PENCE: '8',
  SHIPPING_FULFILMENT_EXTRA_ITEM_LIMIT: '3',
  SHIPPING_EU_SURCHARGE_PENCE: '300',
  SHIPPING_MARKUP_PERCENT: '0',
};

const ROWS = [
  // Ghana: both airmail services.
  { countryCode: 'GH', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 3252, peakPricePence: null },
  { countryCode: 'GH', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 30000, pricePence: 25751, peakPricePence: null },
  { countryCode: 'GH', serviceCode: '010', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 845, peakPricePence: null },
  { countryCode: 'GH', serviceCode: '010', parcelKind: 'parcel' as const, maxWeightG: 2000, pricePence: 3069, peakPricePence: null },
  // Uganda is tracked-only; Tanzania untracked-only. Both are real.
  { countryCode: 'UG', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 2822, peakPricePence: null },
  { countryCode: 'TZ', serviceCode: '010', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 847, peakPricePence: null },
  // UK, both speeds.
  { countryCode: 'GB', serviceCode: '001', parcelKind: 'parcel' as const, maxWeightG: 2000, pricePence: 222, peakPricePence: null },
  { countryCode: 'GB', serviceCode: '002', parcelKind: 'parcel' as const, maxWeightG: 20000, pricePence: 350, peakPricePence: null },
  // BFPO, which must never be offered as a choice.
  { countryCode: 'GB', serviceCode: '015', parcelKind: 'large_letter' as const, maxWeightG: 750, pricePence: 234, peakPricePence: 241 },
];

async function load(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...RATE_ENV, ...overrides };

  const { buildRateCard } = await import('../services/commerce/shipping-rates.service');
  const card = buildRateCard(ROWS);

  // The loader is the only part that touches a database, and what it returns is
  // the only thing the options service uses it for.
  vi.doMock('../services/commerce/shipping-rates.service', async () => {
    const actual = await vi.importActual<typeof import('../services/commerce/shipping-rates.service')>(
      '../services/commerce/shipping-rates.service',
    );
    return {
      ...actual,
      shippingRatesService: { load: async () => card, invalidate: () => {} },
    };
  });

  return import('../services/commerce/shipping-options.service');
}

const book = (over: Record<string, unknown> = {}) => ({
  quantity: 1,
  weightGr: 300,
  heightMm: 198,
  widthMm: 129,
  thicknessMm: 20,
  productForm: 'BC',
  ...over,
});

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../services/commerce/shipping-rates.service');
  process.env = { ...BASE_ENV };
});

describe('shippingOptionsService.list', () => {
  it('offers both airmail services, cheapest first', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options.map((o) => o.serviceCode)).toEqual(['010', '011']);
    expect(options[0].priceGbpPence).toBe(845 + 70);
    expect(options[1].priceGbpPence).toBe(3252 + 70);
  });

  // The cheapest, not the fastest. On most overseas destinations the tracked
  // upgrade costs more than the books in the basket.
  it('recommends the cheapest option', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options.find((o) => o.recommended)?.serviceCode).toBe('010');
    expect(options.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('says which options are tracked', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options.find((o) => o.serviceCode === '010')?.tracked).toBe(false);
    expect(options.find((o) => o.serviceCode === '011')?.tracked).toBe(true);
  });

  // Untracked airmail stops at 2kg while tracked runs to 30kg, so a big basket
  // legitimately loses the cheap option rather than failing outright.
  it('drops an option the basket is too heavy for, keeping the rest', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH',
      items: [book({ weightGr: 1000, quantity: 5 })],
      subtotalGbpPence: 9000,
      currency: 'GBP',
    });

    expect(options.map((o) => o.serviceCode)).toEqual(['011']);
  });

  it('offers only what a destination actually supports', async () => {
    const { shippingOptionsService } = await load();

    const uganda = await shippingOptionsService.list({
      countryCode: 'UG', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });
    const tanzania = await shippingOptionsService.list({
      countryCode: 'TZ', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(uganda.options.map((o) => o.serviceCode)).toEqual(['011']);
    expect(tanzania.options.map((o) => o.serviceCode)).toEqual(['010']);
  });

  it('offers nothing for a destination with no rates', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'ET', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options).toEqual([]);
  });

  // BFPO needs the BFPO number inside the address and is a different address
  // shape entirely, so it must never appear as a delivery choice.
  it('never offers BFPO', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GB', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options.map((o) => o.serviceCode)).toEqual(['001', '002']);
  });

  it('quotes Western Europe as quicker than everywhere else', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options[0].estimatedDaysMin).toBe(7);
    expect(options[0].estimatedDaysMax).toBe(10);
  });

  it('reports an estimated weight', async () => {
    const { shippingOptionsService } = await load();

    const known = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });
    const guessed = await shippingOptionsService.list({
      countryCode: 'GH', items: [book({ weightGr: null })], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(known.weightEstimated).toBe(false);
    expect(guessed.weightEstimated).toBe(true);
  });

  it('converts prices into the buyer’s currency', async () => {
    const { shippingOptionsService } = await load();

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'USD',
    });

    expect(options[0].priceGbpPence).toBe(915);
    expect(options[0].priceMinor).toBe(Math.ceil(915 * 1.25));
  });

  it('offers nothing for an empty basket or an unknown country', async () => {
    const { shippingOptionsService } = await load();

    expect((await shippingOptionsService.list({
      countryCode: 'GH', items: [], subtotalGbpPence: 0, currency: 'GBP',
    })).options).toEqual([]);

    expect((await shippingOptionsService.list({
      countryCode: 'ZZ', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    })).options).toEqual([]);
  });
});

// Before the rate table is switched on, one flat price covers a destination no
// matter which service carries it. Offering two options at an identical price
// would tell the buyer the tracked upgrade is free.
describe('shippingOptionsService.list with the rate table off', () => {
  const OFF = { SHIPPING_USE_RATE_TABLE: 'false', SHIPPING_RATES: 'GB:349,ROW:2499' };

  it('offers exactly one option, at the flat price', async () => {
    const { shippingOptionsService } = await load(OFF);

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options).toHaveLength(1);
    expect(options[0].priceGbpPence).toBe(2499);
    expect(options[0].recommended).toBe(true);
  });

  it('offers the service the order would actually ship by', async () => {
    const { shippingOptionsService } = await load(OFF);

    const ghana = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });
    const uk = await shippingOptionsService.list({
      countryCode: 'GB', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    // The legacy country rule: tracked airmail overseas, second class at home.
    expect(ghana.options[0].serviceCode).toBe('011');
    expect(uk.options[0].serviceCode).toBe('001');
    expect(uk.options[0].priceGbpPence).toBe(349);
  });

  it('offers nothing when the flat table cannot price the destination', async () => {
    const { shippingOptionsService } = await load({
      ...OFF, SHIPPING_RATES: 'GB:349',
    });

    const { options } = await shippingOptionsService.list({
      countryCode: 'GH', items: [book()], subtotalGbpPence: 1500, currency: 'GBP',
    });

    expect(options).toEqual([]);
  });
});

describe('shippingOptionsService.isAvailable', () => {
  it('accepts a service the destination supports', async () => {
    const { shippingOptionsService } = await load();

    expect(await shippingOptionsService.isAvailable('GH', '010')).toBe(true);
    expect(await shippingOptionsService.isAvailable('GH', '011')).toBe(true);
  });

  it('rejects one it does not', async () => {
    const { shippingOptionsService } = await load();

    expect(await shippingOptionsService.isAvailable('TZ', '011')).toBe(false);
    expect(await shippingOptionsService.isAvailable('ET', '010')).toBe(false);
  });

  it('rejects BFPO and nonsense', async () => {
    const { shippingOptionsService } = await load();

    expect(await shippingOptionsService.isAvailable('GB', '015')).toBe(false);
    expect(await shippingOptionsService.isAvailable('GB', '999')).toBe(false);
    expect(await shippingOptionsService.isAvailable('ZZ', '010')).toBe(false);
  });
});

describe('shippingOptionsService.defaultServiceCode', () => {
  // A client that has not built a chooser must not upgrade buyers onto tracked
  // delivery — that is the behaviour this whole change exists to fix.
  it('is the cheapest service, not the tracked one', async () => {
    const { shippingOptionsService } = await load();

    expect(await shippingOptionsService.defaultServiceCode('GH')).toBe('010');
    expect(await shippingOptionsService.defaultServiceCode('GB')).toBe('001');
  });

  it('falls to the only service a destination has', async () => {
    const { shippingOptionsService } = await load();

    expect(await shippingOptionsService.defaultServiceCode('UG')).toBe('011');
    expect(await shippingOptionsService.defaultServiceCode('TZ')).toBe('010');
  });

  it('is null where there is nothing to ship by', async () => {
    const { shippingOptionsService } = await load();

    expect(await shippingOptionsService.defaultServiceCode('ET')).toBeNull();
    expect(await shippingOptionsService.defaultServiceCode('ZZ')).toBeNull();
  });

  // With the flag off, the legacy country rule still decides, so this must not
  // quietly start returning a code.
  it('is null when the rate table is switched off', async () => {
    const { shippingOptionsService } = await load({ SHIPPING_USE_RATE_TABLE: 'false' });

    expect(await shippingOptionsService.defaultServiceCode('GH')).toBeNull();
  });
});

describe('shippingDisplayName', () => {
  it('names the service the buyer chose', async () => {
    const { shippingDisplayName } = await load();

    expect(shippingDisplayName('010')).toBe('Standard international');
    expect(shippingDisplayName('011')).toBe('Tracked international');
  });

  // An old order, or an unrecognised code, must read as "Delivery" rather than
  // breaking the payment page.
  it('falls back to a generic label', async () => {
    const { shippingDisplayName } = await load();

    expect(shippingDisplayName(null)).toBe('Delivery');
    expect(shippingDisplayName('999')).toBe('Delivery');
  });
});
