import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildShoppableCondition,
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
