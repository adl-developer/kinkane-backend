import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Parcel } from '../services/commerce/parcel';

/**
 * The weight-banded quote. Same re-import-under-env pattern as
 * commerce-pricing.test.ts, because the config module reads process.env once at
 * import time.
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

async function load(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...RATE_ENV, ...overrides };
  const pricing = await import('../services/commerce/pricing');
  const rates = await import('../services/commerce/shipping-rates.service');
  return { ...pricing, ...rates };
}

afterEach(() => {
  process.env = { ...BASE_ENV };
});

/** Ghana and the UK, at the prices Gardners actually publish. */
const ROWS = [
  // Tracked airmail to Ghana.
  { countryCode: 'GH', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 250, pricePence: 3061, peakPricePence: null },
  { countryCode: 'GH', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 3252, peakPricePence: null },
  { countryCode: 'GH', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 750, pricePence: 3442, peakPricePence: null },
  // Untracked airmail to Ghana.
  { countryCode: 'GH', serviceCode: '010', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 845, peakPricePence: null },
  { countryCode: 'GH', serviceCode: '010', parcelKind: 'parcel' as const, maxWeightG: 1000, pricePence: 1586, peakPricePence: null },
  // UK second class, both shapes.
  { countryCode: 'GB', serviceCode: '001', parcelKind: 'large_letter' as const, maxWeightG: 250, pricePence: 191, peakPricePence: 198 },
  { countryCode: 'GB', serviceCode: '001', parcelKind: 'large_letter' as const, maxWeightG: 750, pricePence: 234, peakPricePence: 241 },
  { countryCode: 'GB', serviceCode: '001', parcelKind: 'parcel' as const, maxWeightG: 2000, pricePence: 222, peakPricePence: null },
  // Germany, to exercise the EU surcharge.
  { countryCode: 'DE', serviceCode: '011', parcelKind: 'parcel' as const, maxWeightG: 500, pricePence: 615, peakPricePence: null },
];

const parcel = (over: Partial<Parcel> = {}): Parcel => ({
  weightG: 400,
  estimated: false,
  fitsLargeLetter: false,
  ...over,
});

describe('buildRateCard', () => {
  it('sorts bands by weight however they arrive', async () => {
    const { buildRateCard } = await load();
    const card = buildRateCard([...ROWS].reverse());

    const bands = card.get('GH')!.get('011')!.get('parcel')!;
    expect(bands.map((b) => b.maxWeightG)).toEqual([250, 500, 750]);
  });

  it('is keyed by upper-case country code', async () => {
    const { buildRateCard } = await load();
    const card = buildRateCard([{ ...ROWS[0], countryCode: 'gh' }]);

    expect(card.get('GH')).toBeDefined();
  });
});

describe('quoteShipping from the rate table', () => {
  it('charges the cheapest band the parcel fits, plus the fulfilment fee', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const quote = quoteShipping({
      countryCode: 'GH',
      serviceCode: '011',
      itemCount: 1,
      subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 400 }),
      rateCard,
    });

    // 400g falls in the 500g band: £32.52 postage + £0.70 fulfilment.
    expect(quote.gbpPence).toBe(3252 + 70);
    expect(quote.rule).toBe('011:GH:500g');
    expect(quote.serviceCode).toBe('011');
    expect(quote.weightG).toBe(400);
  });

  it('moves up a band when the parcel is heavier', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const quote = quoteShipping({
      countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 501 }), rateCard,
    });

    expect(quote.gbpPence).toBe(3442 + 70);
  });

  // The band is an upper bound, inclusive. Being one gram out here is a whole
  // band's worth of money on every order that sits on a boundary.
  it('treats a band bound as inclusive', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const at = (weightG: number) =>
      quoteShipping({
        countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
        parcel: parcel({ weightG }), rateCard,
      }).rule;

    expect(at(250)).toBe('011:GH:250g');
    expect(at(251)).toBe('011:GH:500g');
  });

  it('prices the same parcel far cheaper untracked', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const quote = quoteShipping({
      countryCode: 'GH', serviceCode: '010', itemCount: 1, subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 400 }), rateCard,
    });

    expect(quote.gbpPence).toBe(845 + 70);
  });

  it('charges the fulfilment fee for at most four items', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const fee = (itemCount: number) =>
      quoteShipping({
        countryCode: 'GH', serviceCode: '010', itemCount, subtotalGbpPence: 1500,
        parcel: parcel({ weightG: 400 }), rateCard,
      }).gbpPence - 845;

    expect(fee(1)).toBe(70);
    expect(fee(2)).toBe(78);
    expect(fee(4)).toBe(94);
    // "no additional charge after 4 items per parcel"
    expect(fee(5)).toBe(94);
    expect(fee(20)).toBe(94);
  });

  it('adds the EU customs surcharge inside the EU only', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const germany = quoteShipping({
      countryCode: 'DE', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 400 }), rateCard,
    });
    const ghana = quoteShipping({
      countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 400 }), rateCard,
    });

    expect(germany.gbpPence).toBe(615 + 70 + 300);
    expect(ghana.gbpPence).toBe(3252 + 70);
  });

  it('applies the configured markup to the whole cost', async () => {
    const { quoteShipping, buildRateCard } = await load({ SHIPPING_MARKUP_PERCENT: '10' });
    const rateCard = buildRateCard(ROWS);

    const quote = quoteShipping({
      countryCode: 'GH', serviceCode: '010', itemCount: 1, subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 400 }), rateCard,
    });

    expect(quote.gbpPence).toBe(915 + Math.round(915 * 0.1));
  });

  it('carries the estimated-weight flag through', async () => {
    const { quoteShipping, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    const quote = quoteShipping({
      countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
      parcel: parcel({ weightG: 400, estimated: true }), rateCard,
    });

    expect(quote.estimatedWeight).toBe(true);
  });

  describe('UK parcel shapes', () => {
    it('uses the large-letter price when the parcel fits one', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      const quote = quoteShipping({
        countryCode: 'GB', serviceCode: '001', itemCount: 1, subtotalGbpPence: 1500,
        parcel: parcel({ weightG: 240, fitsLargeLetter: true }), rateCard,
      });

      expect(quote.gbpPence).toBe(191 + 70);
    });

    it('uses the parcel price when it does not', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      const quote = quoteShipping({
        countryCode: 'GB', serviceCode: '001', itemCount: 1, subtotalGbpPence: 1500,
        parcel: parcel({ weightG: 240, fitsLargeLetter: false }), rateCard,
      });

      expect(quote.gbpPence).toBe(222 + 70);
    });

    // Everywhere except the UK has parcel prices only, so a fitting parcel must
    // fall through rather than finding nothing.
    it('falls back to parcel prices where there is no large-letter table', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      const quote = quoteShipping({
        countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
        parcel: parcel({ weightG: 240, fitsLargeLetter: true }), rateCard,
      });

      expect(quote.gbpPence).toBe(3061 + 70);
    });
  });

  describe('peak season', () => {
    // 17 November to 6 January, which wraps the new year — the half of the
    // window in January is the half a naive range check gets wrong.
    it('charges the peak price inside the window, at both ends of the year', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      const on = (iso: string) =>
        quoteShipping({
          countryCode: 'GB', serviceCode: '001', itemCount: 1, subtotalGbpPence: 1500,
          parcel: parcel({ weightG: 240, fitsLargeLetter: true }), rateCard,
          at: new Date(iso),
        }).gbpPence - 70;

      expect(on('2025-11-16T12:00:00Z')).toBe(191);
      expect(on('2025-11-17T12:00:00Z')).toBe(198);
      expect(on('2025-12-20T12:00:00Z')).toBe(198);
      expect(on('2026-01-06T12:00:00Z')).toBe(198);
      expect(on('2026-01-07T12:00:00Z')).toBe(191);
      expect(on('2026-06-01T12:00:00Z')).toBe(191);
    });

    it('leaves services with no peak price alone', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      const quote = quoteShipping({
        countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
        parcel: parcel({ weightG: 400 }), rateCard, at: new Date('2025-12-20T12:00:00Z'),
      });

      expect(quote.gbpPence).toBe(3252 + 70);
      expect(quote.rule).not.toContain('peak');
    });
  });

  describe('refusals', () => {
    it('refuses a destination with no rate for that service', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      expect(() =>
        quoteShipping({
          countryCode: 'ET', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
          parcel: parcel(), rateCard,
        }),
      ).toThrow(/no 011 shipping rate for ET/i);
    });

    // Quoting the top band for something above it undercharges by an unbounded
    // amount, so this is a refusal rather than a clamp.
    it('refuses a parcel heavier than every band', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      expect(() =>
        quoteShipping({
          countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
          parcel: parcel({ weightG: 5000 }), rateCard,
        }),
      ).toThrow(/too heavy/i);
    });
  });

  describe('falling back to the flat table', () => {
    it('ignores the rate card when the feature is off', async () => {
      const { quoteShipping, buildRateCard } = await load({ SHIPPING_USE_RATE_TABLE: 'false' });
      const rateCard = buildRateCard(ROWS);

      const quote = quoteShipping({
        countryCode: 'GH', serviceCode: '011', itemCount: 1, subtotalGbpPence: 1500,
        parcel: parcel(), rateCard,
      });

      expect(quote).toEqual({ gbpPence: 1199, rule: 'ROW' });
    });

    it('uses the flat table when a caller passes no parcel', async () => {
      const { quoteShipping, buildRateCard } = await load();
      const rateCard = buildRateCard(ROWS);

      const quote = quoteShipping({
        countryCode: 'GH', itemCount: 1, subtotalGbpPence: 1500, rateCard,
      });

      expect(quote.rule).toBe('ROW');
    });
  });
});

describe('availableServiceCodes', () => {
  it('lists what a destination can actually be shipped by', async () => {
    const { availableServiceCodes, buildRateCard } = await load();
    const rateCard = buildRateCard(ROWS);

    expect(availableServiceCodes(rateCard, 'GH')).toEqual(['010', '011']);
    expect(availableServiceCodes(rateCard, 'DE')).toEqual(['011']);
    expect(availableServiceCodes(rateCard, 'GB')).toEqual(['001']);
  });

  it('is empty for a destination with no rates at all', async () => {
    const { availableServiceCodes, buildRateCard } = await load();
    expect(availableServiceCodes(buildRateCard(ROWS), 'ET')).toEqual([]);
  });
});
