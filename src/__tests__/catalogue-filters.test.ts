import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildShoppableCondition } from '../lib/shoppable';

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
const sqlFor = (...args: Parameters<typeof buildShoppableCondition>) =>
  dialect.sqlToQuery(buildShoppableCondition(...args));

const BASE_ENV = { ...process.env };

async function loadPricing(overrides: Record<string, string> = {}) {
  vi.resetModules();
  process.env = { ...BASE_ENV, ...overrides };
  return import('../services/commerce/pricing');
}

describe('price bounds in buildShoppableCondition', () => {
  it('adds nothing when no bounds are given', () => {
    // The unfiltered shape has to stay byte-identical: every existing shoppable
    // request shares a cache key with it.
    expect(sqlFor().sql).toBe(sqlFor({}).sql);
    expect(sqlFor().sql).not.toContain('rrp_gbp * 100');
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

  it('keeps the bounds inside the existing EXISTS rather than adding a second', () => {
    // Two correlated subqueries would double the index probes per candidate row
    // for a comparison on a row already fetched.
    const { sql } = sqlFor({ minGbpPence: 500, maxGbpPence: 2000 });
    expect(sql.toLowerCase().split('exists').length - 1).toBe(1);
  });

  it('still enforces everything shoppable meant before', () => {
    const { sql } = sqlFor({ minGbpPence: 500 });
    const lower = sql.toLowerCase();
    expect(lower).toContain('"books"."isbn13" is not null');
    expect(lower).toContain('gs.rrp_gbp > 0');
    expect(lower).toContain('report_code');
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

  it('converts a customer-typed bound back to GBP pence', async () => {
    const { fromPresentment } = await loadPricing(ENV);
    // $100.00 at 1.25 is £80.00.
    expect(fromPresentment(10_000, 'USD')).toBe(8000);
  });

  it('inverts toPresentment closely enough to bound a filter', async () => {
    const { fromPresentment, toPresentment } = await loadPricing(ENV);
    for (const gbpPence of [199, 999, 1299, 2650, 9999]) {
      const there = toPresentment(gbpPence, 'USD');
      const back = fromPresentment(there, 'USD');
      // Not exact by construction — the forward trip rounds up twice. One penny
      // of slack on a filter boundary is invisible; a systematic drift is not.
      expect(Math.abs(back - gbpPence)).toBeLessThanOrEqual(1);
    }
  });

  it('accounts for the FX buffer, so the bound matches the displayed price', async () => {
    const { fromPresentment } = await loadPricing({ ...ENV, FX_BUFFER_PERCENT: '3' });
    // Ignoring the buffer would return 8000 here and filter against prices the
    // shop never showed.
    expect(fromPresentment(10_000, 'USD')).toBe(7767);
  });

  it('refuses a currency with no configured rate rather than guessing', async () => {
    const { fromPresentment } = await loadPricing(ENV);
    expect(() => fromPresentment(10_000, 'NGN')).toThrow();
  });
});
