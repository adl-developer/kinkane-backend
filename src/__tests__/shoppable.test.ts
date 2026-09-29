import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildShoppableCondition,
  buildShopBandCondition,
  buildMarketRestrictedCondition,
  buildPriceBoundsCondition,
  planShopBands,
  isSellableBand,
  SHOP_BAND,
  SHOP_BAND_ORDER,
  type ShopBand,
  UNSUPPLIABLE_REPORT_CODES,
  UNSUPPLIABLE_REPORT_CODE_SET,
  availableQuantityFor,
  stockTierFor,
  STOCK_TIER,
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

// The bands are what `shoppable=true` orders the sellable books by, once the
// unsellable ones have been filtered out. Same reasoning as above: the
// interesting properties are properties of the SQL, and the one that matters
// most is that the four listed bands partition the sellable catalogue. A
// sellable book in no band vanishes from the listing entirely.
describe('buildShopBandCondition', () => {
  const bandSql = (band: ShopBand) =>
    dialect.sqlToQuery(buildShopBandCondition(band)).sql.toLowerCase();
  const restrictedProbe = /\band\s+\(select exists\s*\(\s*select 1 from "gardners_market_restrictions" mr/;
  const unrestrictedProbe = /\bnot\s+\(select exists\s*\(\s*select 1 from "gardners_market_restrictions" mr/;

  it('puts stocked, priced, suppliable books in the in-stock bands', () => {
    for (const band of [SHOP_BAND.IN_STOCK, SHOP_BAND.IN_STOCK_RESTRICTED]) {
      const s = bandSql(band);
      expect(s).toContain('"books"."isbn13" is not null');
      expect(s).toContain('gs.rrp_gbp > 0');
      expect(s).toContain('coalesce(gs.stock_qty, 0) > 0');
      expect(s).toContain('not in');
    }
  });

  it('puts suppliable-but-unstocked books in the to-order bands, not out of the shop', () => {
    // GXC and M/D live here: no shelf, still orderable.
    for (const band of [SHOP_BAND.TO_ORDER, SHOP_BAND.TO_ORDER_RESTRICTED]) {
      const s = bandSql(band);
      expect(s).toContain('coalesce(gs.stock_qty, 0) = 0');
      expect(s).toContain('gs.rrp_gbp > 0');
    }
  });

  it('treats a null stock_qty as no stock, not as stock', () => {
    // "The feed has never said" is not a shelf. Without the COALESCE those rows
    // satisfy neither band and disappear.
    for (const band of SHOP_BAND_ORDER) {
      expect(bandSql(band)).toContain('coalesce(gs.stock_qty, 0)');
    }
  });

  it('splits each stock band on the same restriction probe, one side each', () => {
    // EXISTS and NOT EXISTS of one subquery: together they cover every row, so
    // the restricted and unrestricted halves partition the stock band exactly.
    for (const band of [SHOP_BAND.IN_STOCK_RESTRICTED, SHOP_BAND.TO_ORDER_RESTRICTED]) {
      const s = bandSql(band);
      expect(s).toMatch(restrictedProbe);
      expect(s).not.toMatch(unrestrictedProbe);
    }
    for (const band of [SHOP_BAND.IN_STOCK, SHOP_BAND.TO_ORDER]) {
      const s = bandSql(band);
      expect(s).toMatch(unrestrictedProbe);
      expect(s).not.toMatch(restrictedProbe);
    }
  });

  it('probes restrictions per row, not as a join the planner can hash', () => {
    // A bare NOT EXISTS became a hash anti-join over the whole restrictions table
    // plus a sort — 714ms against 14ms for page 1 of band 0. See
    // buildMarketRestrictedCondition.
    const probe = dialect.sqlToQuery(buildMarketRestrictedCondition()).sql.toLowerCase();
    expect(probe).toMatch(/^\(select exists \(/);
  });

  it('counts a restriction in any region when there is no customer country', () => {
    // Nothing to test against, so the probe must not name a region or a flag —
    // any restriction row at all is a restriction.
    const probe = dialect.sqlToQuery(buildMarketRestrictedCondition()).sql.toLowerCase();
    expect(probe).toContain('mr.isbn13 = "books"."isbn13"');
    expect(probe).not.toContain('region_code');
    expect(probe).not.toContain('flag');
  });

  describe('for a known customer country', () => {
    const regions = ['AFR', 'GH'];
    const compiledProbe = dialect.sqlToQuery(buildMarketRestrictedCondition(regions));
    const probe = compiledProbe.sql.toLowerCase();

    it('restricts on a denylist row naming the customer\'s region', () => {
      expect(probe).toMatch(/mr\.flag = 'n' and upper\(mr\.region_code\) in \(\$1, \$2\)/);
    });

    it('restricts on an allowlist that names none of the customer\'s regions', () => {
      expect(probe).toMatch(/mr\.flag = 'y'\s+and not exists/);
      expect(probe).toMatch(/mr_allow\.flag = 'y'\s+and upper\(mr_allow\.region_code\) in \(\$3, \$4\)/);
    });

    it('binds the regions rather than inlining them', () => {
      expect(compiledProbe.params).toEqual(['AFR', 'GH', 'AFR', 'GH']);
    });

    it('stays a per-row scalar probe', () => {
      expect(probe).toMatch(/^\(select exists \(/);
    });

    it('reaches the band predicates', () => {
      const band = dialect.sqlToQuery(buildShopBandCondition(SHOP_BAND.IN_STOCK, regions));
      expect(band.params).toEqual([...UNSUPPLIABLE_REPORT_CODES, 'AFR', 'GH', 'AFR', 'GH']);
    });

    it('falls back to any restriction when the country is unknown', () => {
      for (const unknown of [undefined, []]) {
        const s = dialect.sqlToQuery(buildMarketRestrictedCondition(unknown)).sql.toLowerCase();
        expect(s).not.toContain('region_code');
      }
    });
  });

  it('lists stock ahead of restriction', () => {
    // Every book on the shelf, restricted or not, comes before any to-order book.
    expect(SHOP_BAND_ORDER).toEqual([
      SHOP_BAND.IN_STOCK,
      SHOP_BAND.IN_STOCK_RESTRICTED,
      SHOP_BAND.TO_ORDER,
      SHOP_BAND.TO_ORDER_RESTRICTED,
    ]);
  });

  it('never walks the unsellable band', () => {
    // `shoppable=true` excludes what cannot be bought rather than sinking it.
    expect(SHOP_BAND_ORDER).not.toContain(SHOP_BAND.UNSELLABLE);
  });

  it('defines UNSELLABLE as the complement of the supply test, including books with no ISBN13', () => {
    const s = bandSql(SHOP_BAND.UNSELLABLE);
    expect(s).toContain('"books"."isbn13" is null');
    expect(s).toContain('not exists');
    // It must not mention stock or restriction: an unstocked or restricted but
    // orderable book belongs to a listed band, and claiming it here too would
    // put one book in two bands.
    expect(s).not.toContain('stock_qty');
    expect(s).not.toContain('gardners_market_restrictions');
  });

  it('binds the same unsuppliable codes as the filter and the checkout gate', () => {
    for (const band of [...SHOP_BAND_ORDER, SHOP_BAND.UNSELLABLE]) {
      expect(dialect.sqlToQuery(buildShopBandCondition(band)).params).toEqual([
        ...UNSUPPLIABLE_REPORT_CODES,
      ]);
    }
  });

  it('calls only UNSELLABLE unsellable', () => {
    for (const band of SHOP_BAND_ORDER) expect(isSellableBand(band)).toBe(true);
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
  // Sizes of bands 0, 1 and 2; band 3 is the tail and is never counted.
  const sizes = [100, 20, 50];

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
    expect(planShopBands(125, 10, sizes)).toEqual([{ band: 2, offset: 5, take: 10 }]);
  });

  it('can span all four bands at once', () => {
    expect(planShopBands(95, 100, [100, 5, 5])).toEqual([
      { band: 0, offset: 95, take: 5 },
      { band: 1, offset: 0, take: 5 },
      { band: 2, offset: 0, take: 5 },
      { band: 3, offset: 0, take: 85 },
    ]);
  });

  it('treats the last band as unbounded, so it never needs a count', () => {
    // Planning past its real end just fetches fewer rows, which ends the listing.
    const [segment] = planShopBands(1_000_000, 20, sizes);
    expect(segment).toEqual({ band: 3, offset: 999_830, take: 20 });
  });

  it('ignores a size given for the last band', () => {
    expect(planShopBands(180, 20, [100, 20, 50, 5])).toEqual([
      { band: 3, offset: 10, take: 20 },
    ]);
  });

  it('treats a band with no size as unbounded', () => {
    expect(planShopBands(150, 10, [100])).toEqual([{ band: 1, offset: 50, take: 10 }]);
  });

  it('skips empty leading bands', () => {
    expect(planShopBands(0, 10, [0, 0, 0])).toEqual([{ band: 3, offset: 0, take: 10 }]);
  });
});

// availableQuantity sits on every book response and drives the quantity
// stepper, so it has to agree with what the cart will actually accept — a
// stepper that offers 5 and a basket that 409s on 5 is the bug this prevents.
describe('availableQuantityFor', () => {
  const MAX = 10;
  const stock = (over: Partial<{ rrpGbp: string | null; stockQty: number | null; reportCode: string | null }> = {}) => ({
    rrpGbp: '9.99',
    stockQty: 4,
    reportCode: null,
    ...over,
  });

  it('is the stock figure for a stocked title under the cap', () => {
    expect(availableQuantityFor(stock(), MAX)).toBe(4);
  });

  it('never exceeds the per-line cap, so wholesale stock is not published', () => {
    expect(availableQuantityFor(stock({ stockQty: 1000 }), MAX)).toBe(MAX);
  });

  it('is 0 for a stocked title with no stock', () => {
    expect(availableQuantityFor(stock({ stockQty: 0 }), MAX)).toBe(0);
    expect(availableQuantityFor(stock({ stockQty: null }), MAX)).toBe(0);
  });

  it('is the cap for supply-to-order titles, which report zero stock but are orderable', () => {
    expect(availableQuantityFor(stock({ stockQty: 0, reportCode: 'GXC' }), MAX)).toBe(MAX);
    expect(availableQuantityFor(stock({ stockQty: 0, reportCode: ' m/d ' }), MAX)).toBe(MAX);
  });

  it('is 0 whatever the stock when the report code says it cannot be supplied', () => {
    for (const code of UNSUPPLIABLE_REPORT_CODES) {
      expect(availableQuantityFor(stock({ stockQty: 50, reportCode: code }), MAX)).toBe(0);
    }
  });

  it('is 0 without a live price', () => {
    expect(availableQuantityFor(stock({ rrpGbp: null }), MAX)).toBe(0);
    expect(availableQuantityFor(stock({ rrpGbp: '0.00' }), MAX)).toBe(0);
  });

  it('is 0 when the supplier has no row for the book at all', () => {
    expect(availableQuantityFor(undefined, MAX)).toBe(0);
  });
});

// The edition picker leads with a copy on the shelf, then an order-in one, then
// one that cannot be bought. availableQuantity alone cannot tell the first two
// apart — an order-in title reports the full cap — hence a tier of its own.
describe('stockTierFor', () => {
  const MAX = 10;
  const stock = (over: Partial<{ rrpGbp: string | null; stockQty: number | null; reportCode: string | null }> = {}) => ({
    rrpGbp: '9.99',
    stockQty: 4,
    reportCode: null,
    ...over,
  });

  it('is in stock for a stocked title with copies on the shelf', () => {
    expect(stockTierFor(stock(), MAX)).toBe(STOCK_TIER.IN_STOCK);
  });

  it('is order-in for a supply-to-order title, even though its quantity is the full cap', () => {
    expect(stockTierFor(stock({ stockQty: 0, reportCode: 'GXC' }), MAX)).toBe(STOCK_TIER.TO_ORDER);
    expect(availableQuantityFor(stock({ stockQty: 0, reportCode: 'GXC' }), MAX)).toBe(MAX);
  });

  it('is unavailable when nothing can be bought', () => {
    expect(stockTierFor(stock({ stockQty: 0 }), MAX)).toBe(STOCK_TIER.UNAVAILABLE);
    expect(stockTierFor(stock({ reportCode: 'NYP' }), MAX)).toBe(STOCK_TIER.UNAVAILABLE);
    expect(stockTierFor(stock({ rrpGbp: null }), MAX)).toBe(STOCK_TIER.UNAVAILABLE);
    expect(stockTierFor(undefined, MAX)).toBe(STOCK_TIER.UNAVAILABLE);
  });

  it('orders the tiers so that lower is better', () => {
    expect(STOCK_TIER.IN_STOCK).toBeLessThan(STOCK_TIER.TO_ORDER);
    expect(STOCK_TIER.TO_ORDER).toBeLessThan(STOCK_TIER.UNAVAILABLE);
  });
});
