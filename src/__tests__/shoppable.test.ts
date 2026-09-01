import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildShoppableCondition,
  buildShopBandCondition,
  buildPriceBoundsCondition,
  planShopBands,
  isSellableBand,
  SHOP_BAND,
  UNSUPPLIABLE_REPORT_CODES,
  UNSUPPLIABLE_REPORT_CODE_SET,
} from '../lib/shoppable';

// The `shoppable=true` filter decides what the e-commerce section is allowed to
// put in front of a customer. It is checked here rather than through the
// endpoint because the interesting properties are properties of the SQL — what
// it tests, and just as importantly what it does *not* test, since a filter that
// quietly over-excludes shrinks the shop with nothing to notice it by.

const dialect = new PgDialect();
const compiled = dialect.sqlToQuery(buildShoppableCondition());
// Keyword casing is whatever the builder's template literal used, and is not
// what any of these assertions are about — fold it away so a cosmetic reword of
// the SQL cannot fail a test about its meaning.
const sql = compiled.sql.toLowerCase();

describe('buildShoppableCondition', () => {
  it('requires an ISBN13', () => {
    expect(sql).toContain('"books"."isbn13" is not null');
  });

  it('requires a live supplier price, not an ONIX one', () => {
    expect(sql).toContain('gs.rrp_gbp > 0');
    // book_prices is edition metadata for roughly half the catalogue; pricing a
    // shop listing from it would advertise prices we cannot honour.
    expect(sql).not.toContain('book_prices');
  });

  it('correlates against gardners_stock on isbn13', () => {
    expect(sql).toContain('"gardners_stock"');
    expect(sql).toContain('gs.isbn13 = "books"."isbn13"');
    // Not book_id: that column is backfilled after the fact and is null for any
    // ISBN whose stock row landed before its catalogue row did.
    expect(sql).not.toContain('gs.book_id');
  });

  it('excludes unsuppliable report codes, case- and whitespace-insensitively', () => {
    expect(sql).toContain('upper(btrim(gs.report_code))');
    expect(sql).toContain('not in');
  });

  it('binds exactly the codes the checkout gate rejects', () => {
    // The whole reason both live in lib/shoppable: a code the cart rejects but
    // browse still lists is a title that 409s the moment it is added to a cart.
    expect(compiled.params).toEqual([...UNSUPPLIABLE_REPORT_CODES]);
    for (const code of compiled.params) {
      expect(UNSUPPLIABLE_REPORT_CODE_SET.has(code as string)).toBe(true);
    }
  });

  it('keeps a null report code — no code means no problem', () => {
    expect(sql).toContain('gs.report_code is null');
  });

  it('does not filter on stock', () => {
    // Stock moves hourly. Filtering here would make books drop out of the
    // catalogue and reappear between page requests, with the row cache freezing
    // whichever answer it saw. Out-of-stock books ship with inStock: false.
    expect(sql).not.toContain('stock_qty');
  });

  it('does not apply market restrictions', () => {
    // Those need a destination country, which this public endpoint has none of,
    // and the restriction check fails closed — here that would silently shrink
    // the catalogue rather than raise a visible 409.
    expect(sql).not.toContain('market_restrictions');
  });
});

describe('supply-to-order report codes', () => {
  it('never overlaps the unsuppliable list', async () => {
    const { UNSUPPLIABLE_REPORT_CODE_SET, SUPPLY_TO_ORDER_REPORT_CODES } = await import('../lib/shoppable');
    // A code in both lists would be simultaneously "cannot be supplied" and
    // "supplied to order" — whichever check ran first would decide, silently.
    for (const code of SUPPLY_TO_ORDER_REPORT_CODES) {
      expect(UNSUPPLIABLE_REPORT_CODE_SET.has(code)).toBe(false);
    }
  });

  it('recognises the codes Gardners documents as never killed', async () => {
    const { isSupplyToOrder } = await import('../lib/shoppable');
    // "Print On Demand titles (POD/MD) and Gardners Extended Catalogue titles
    // (GXC) are never killed" — I12 specification.
    expect(isSupplyToOrder('GXC')).toBe(true);
    expect(isSupplyToOrder('M/D')).toBe(true);
    expect(isSupplyToOrder('MD')).toBe(true);
  });

  it('folds case and whitespace, matching the feed', async () => {
    const { isSupplyToOrder } = await import('../lib/shoppable');
    expect(isSupplyToOrder(' gxc ')).toBe(true);
    expect(isSupplyToOrder('m/d')).toBe(true);
  });

  it('treats an absent or unknown code as stocked', async () => {
    const { isSupplyToOrder } = await import('../lib/shoppable');
    // Erring this way keeps the stock gate on: an unknown code does not become
    // silently orderable with no shelf behind it.
    expect(isSupplyToOrder(null)).toBe(false);
    expect(isSupplyToOrder(undefined)).toBe(false);
    expect(isSupplyToOrder('')).toBe(false);
    expect(isSupplyToOrder('NYP')).toBe(false);
    expect(isSupplyToOrder('WAT')).toBe(false);
  });
});

// The bands are what `shoppable=true` now *orders* by, having stopped filtering.
// Same reasoning as above: the interesting properties are properties of the SQL,
// and the one that matters most is that the three bands partition the catalogue.
// A book in no band vanishes from the listing entirely — a filter by accident,
// which is the exact bug turning the filter into a ranking was meant to remove.
describe('buildShopBandCondition', () => {
  const bandSql = (band: 0 | 1 | 2) =>
    dialect.sqlToQuery(buildShopBandCondition(band)).sql.toLowerCase();

  it('puts stocked, priced, suppliable books in band 0', () => {
    const s = bandSql(SHOP_BAND.IN_STOCK);
    expect(s).toContain('"books"."isbn13" is not null');
    expect(s).toContain('gs.rrp_gbp > 0');
    expect(s).toContain('coalesce(gs.stock_qty, 0) > 0');
    expect(s).toContain('not in');
  });

  it('puts suppliable-but-unstocked books in band 1, not out of the shop', () => {
    const s = bandSql(SHOP_BAND.TO_ORDER);
    // GXC and M/D live here: no shelf, still orderable. Band 1 is what keeps
    // them listed behind the stocked titles instead of below the dead ones.
    expect(s).toContain('coalesce(gs.stock_qty, 0) = 0');
    expect(s).toContain('gs.rrp_gbp > 0');
  });

  it('treats a null stock_qty as no stock, not as stock', () => {
    // "The feed has never said" is not a shelf. Without the COALESCE those rows
    // satisfy neither band and disappear.
    expect(bandSql(SHOP_BAND.IN_STOCK)).toContain('coalesce(gs.stock_qty, 0)');
    expect(bandSql(SHOP_BAND.TO_ORDER)).toContain('coalesce(gs.stock_qty, 0)');
  });

  it('sweeps everything else into band 2, including books with no ISBN13', () => {
    const s = bandSql(SHOP_BAND.UNSELLABLE);
    expect(s).toContain('"books"."isbn13" is null');
    expect(s).toContain('not exists');
  });

  it('defines band 2 as the complement of the supply test, not of the stock test', () => {
    // Band 2 must not mention stock at all: an unstocked-but-orderable book is
    // band 1, and a band 2 that tested stock would claim it too — putting one
    // book in two bands, which double-counts it across a page boundary.
    expect(bandSql(SHOP_BAND.UNSELLABLE)).not.toContain('stock_qty');
  });

  it('binds the same unsuppliable codes as the filter and the checkout gate', () => {
    for (const band of [SHOP_BAND.IN_STOCK, SHOP_BAND.TO_ORDER, SHOP_BAND.UNSELLABLE]) {
      expect(dialect.sqlToQuery(buildShopBandCondition(band)).params).toEqual([
        ...UNSUPPLIABLE_REPORT_CODES,
      ]);
    }
  });

  it('calls only band 2 unsellable', () => {
    expect(isSellableBand(SHOP_BAND.IN_STOCK)).toBe(true);
    expect(isSellableBand(SHOP_BAND.TO_ORDER)).toBe(true);
    expect(isSellableBand(SHOP_BAND.UNSELLABLE)).toBe(false);
  });
});

describe('buildPriceBoundsCondition', () => {
  it('is nothing at all when neither bound was asked for', () => {
    // The common case: `shoppable=true` with no price range must add no
    // predicate whatsoever, or it would filter the very rows it means to rank.
    expect(buildPriceBoundsCondition({})).toBeUndefined();
  });

  it('compares in pence against a pounds column', () => {
    const compiledBounds = dialect.sqlToQuery(
      buildPriceBoundsCondition({ minGbpPence: 500, maxGbpPence: 1000 })!,
    );
    expect(compiledBounds.sql.toLowerCase()).toContain('gs.rrp_gbp * 100');
    expect(compiledBounds.params).toEqual([500, 1000]);
  });

  it('does not smuggle the report-code test back in', () => {
    // Price is a filter; supply is a ranking. Folding the codes in here would
    // silently re-exclude the unsellable tail from every price-filtered page in
    // a way the caller never asked for.
    const s = dialect.sqlToQuery(buildPriceBoundsCondition({ minGbpPence: 500 })!).sql.toLowerCase();
    expect(s).not.toContain('report_code');
  });
});

describe('planShopBands', () => {
  const sizes = { inStock: 100, toOrder: 50 };

  it('answers a first page from one band', () => {
    // The common case, and the one the whole predicate-not-sort-key design
    // exists to keep cheap: one band, one query, one index-backed plan.
    expect(planShopBands(0, 20, sizes)).toEqual([{ band: 0, offset: 0, take: 20 }]);
  });

  it('splits a page that straddles a boundary, in band order', () => {
    expect(planShopBands(90, 20, sizes)).toEqual([
      { band: 0, offset: 90, take: 10 },
      { band: 1, offset: 0, take: 10 },
    ]);
  });

  it('skips bands that are entirely behind the offset', () => {
    expect(planShopBands(150, 10, sizes)).toEqual([{ band: 2, offset: 0, take: 10 }]);
  });

  it('can span all three bands at once', () => {
    expect(planShopBands(95, 100, { inStock: 100, toOrder: 5 })).toEqual([
      { band: 0, offset: 95, take: 5 },
      { band: 1, offset: 0, take: 5 },
      { band: 2, offset: 0, take: 90 },
    ]);
  });

  it('never runs out of band 2, which is unbounded', () => {
    // Band 2 is the tail of the catalogue and has no count of its own — a plan
    // that stopped short there would truncate the last page of every listing.
    const [segment] = planShopBands(1_000_000, 20, sizes);
    expect(segment).toEqual({ band: 2, offset: 999_850, take: 20 });
  });

  it('offsets into band 2 by what the earlier bands actually held', () => {
    expect(planShopBands(200, 5, sizes)).toEqual([{ band: 2, offset: 50, take: 5 }]);
  });

  it('starts at band 0 when the earlier bands are empty', () => {
    expect(planShopBands(0, 10, { inStock: 0, toOrder: 0 })).toEqual([
      { band: 2, offset: 0, take: 10 },
    ]);
  });
});
