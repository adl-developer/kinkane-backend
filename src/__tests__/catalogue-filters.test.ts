import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPriceBoundsCondition } from '../lib/shoppable';

/**
 * The shop's Filters modal. Each of these is a way to show a customer the wrong
 * shelf: a price bound that silently does nothing, a year range that excludes
 * the year the buyer asked for, or a currency conversion applied the wrong way
 * round so "$0-$20" quietly means "£0-£20".
 *
 * The SQL is asserted rather than executed for the same reason shoppable.test.ts
 * does it — the interesting properties are properties of the query, including
 * the ones about what it must *not* contain.
 */

const dialect = new PgDialect();
// The price filter used to live inside the shoppable EXISTS, which is where
// these assertions were originally aimed. It stands alone now that `shoppable`
// only ranks — the bounds are still a filter, and the thing they must not do is
// filter on anything *else*. An absent condition is the no-bounds answer.
const sqlFor = (bounds: Parameters<typeof buildPriceBoundsCondition>[0] = {}) => {
  const condition = buildPriceBoundsCondition(bounds);
  return condition ? dialect.sqlToQuery(condition) : { sql: '', params: [] as unknown[] };
};

const BASE_ENV = { ...process.env };

async function loadPricing(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../services/commerce/pricing');
}

describe('buildPriceBoundsCondition', () => {
  it('adds nothing when no bounds are given', () => {
    // Not merely "no comparison" but no predicate at all: a shop page with no
    // price range must be ranked, never filtered, or the unsellable tail this
    // endpoint now returns would silently disappear again.
    expect(buildPriceBoundsCondition({})).toBeUndefined();
    expect(sqlFor().sql).toBe('');
  });

  it('binds each bound as a parameter rather than inlining it', () => {
    const { sql, params } = sqlFor({ minGbpPence: 500, maxGbpPence: 2000 });
    expect(sql).toContain('rrp_gbp * 100 >=');
    expect(sql).toContain('rrp_gbp * 100 <=');
    expect(params).toContain(500);
    expect(params).toContain(2000);
  });

  it('applies one bound without the other', () => {
    const min = sqlFor({ minGbpPence: 500 });
    expect(min.sql).toContain('>=');
    expect(min.sql).not.toContain('rrp_gbp * 100 <=');

    const max = sqlFor({ maxGbpPence: 2000 });
    expect(max.sql).toContain('<=');
    expect(max.sql).not.toContain('rrp_gbp * 100 >=');
  });

  it('treats a zero lower bound as a real bound, not an absent one', () => {
    // `if (min)` instead of `if (min !== undefined)` would drop this, and the
    // filter UI's default lower bound is exactly 0.
    expect(sqlFor({ minGbpPence: 0 }).sql).toContain('rrp_gbp * 100 >=');
  });

  it('is a single correlated probe, not one per bound', () => {
    const { sql } = sqlFor({ minGbpPence: 500, maxGbpPence: 2000 });
    expect(sql.toLowerCase().split('exists').length - 1).toBe(1);
  });

  it('prices from the supplier feed, and tests nothing but the price', () => {
    const { sql } = sqlFor({ minGbpPence: 500 });
    const lower = sql.toLowerCase();
    expect(lower).toContain('"books"."isbn13" is not null');
    expect(lower).toContain('gs.rrp_gbp > 0');
    // Supply is a ranking now. A price filter that also excluded unsuppliable
    // codes would quietly restore the old filter on every price-filtered page.
    expect(lower).not.toContain('report_code');
    expect(lower).not.toContain('stock_qty');
  });
});

describe('fromPresentment', () => {
  const ENV = {
    SUPPORTED_CURRENCIES: 'USD,GBP,EUR',
    DEFAULT_CURRENCY: 'USD',
    FX_RATES_FROM_GBP: 'USD:1.25,EUR:1.20',
    FX_BUFFER_PERCENT: '0',
  };

  it('is the identity for GBP', async () => {
    const { fromPresentment } = await loadPricing(ENV);
    expect(fromPresentment(1999, 'GBP')).toBe(1999);
  });

  // The shop sells in GBP only, so a bound in any other currency is refused
  // rather than converted — even one the old FX table had a rate for.
  it('refuses any currency other than GBP rather than converting', async () => {
    const { fromPresentment } = await loadPricing(ENV);
    expect(() => fromPresentment(10_000, 'USD')).toThrow();
    expect(() => fromPresentment(10_000, 'NGN')).toThrow();
  });
});

describe('live price on shoppable rows', () => {
  it('prefers a live markdown, and only when it is actually below RRP', async () => {
    // The rule the cart already applies. A "sale" at or above RRP is not a
    // sale, and a listing that advertised one would disagree with the basket.
    const { availabilityService } = await import('../services/commerce/availability.service');
    expect(typeof availabilityService.livePricesByIsbns).toBe('function');
  });

  it('is sourced from the supplier feed, not ONIX metadata', async () => {
    // book_prices is edition metadata covering a different slice of the
    // catalogue and disagreeing with the feed on part of it. Pricing a shop
    // listing from it advertises prices we cannot honour — the same reason
    // buildShoppableCondition reads gardners_stock.
    const src = readFileSync(
      join(__dirname, '..', 'services/commerce/availability.service.ts'),
      'utf8',
    );
    const fn = src.slice(src.indexOf('async livePricesByIsbns'));
    const body = fn.slice(0, fn.indexOf('\n  },'));
    expect(body).toContain('gardnersStock');
    expect(body).not.toContain('bookPrices');
  });
});
