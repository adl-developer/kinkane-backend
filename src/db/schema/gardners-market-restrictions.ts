/**
 * Gardners Books wholesaler feed ingestion tables — owned by the server
 * (migrations run here). The onix_ingester service reads/writes these
 * tables but does NOT migrate them.
 */
import { pgTable, serial, integer, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { books } from './books';

// Small static lookup — region code to display name. Tiny (dozens of rows),
// upserted wholesale on every sync, no mark-and-sweep needed.
export const gardnersRegions = pgTable('gardners_regions', {
  code: varchar('code', { length: 10 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
});

// Raw restriction rows, one per (isbn13, regionCode) pair — this matches the
// real RESTRICT.CSV format verified against the live server (one region per
// row, the same ISBN repeats across multiple rows), NOT the comma-list shape
// shown in Gardners' own I17 spec examples. flag='Y' means the listed regions
// are the ONLY ones the title can be sold in (allowlist); flag='N' means the
// listed regions are where it CANNOT be sold (denylist). Regions not
// mentioned at all for a given ISBN default to sellable.
//
// This table stores facts only — it does NOT precompute a "sellable in
// Ghana" boolean. That aggregation is a server/API-layer concern, since it
// depends on which region code(s) represent Ghana (unconfirmed as of writing
// — not found in the REGIONS.CSV sample pulled during discovery).
export const gardnersMarketRestrictions = pgTable(
  'gardners_market_restrictions',
  {
    id: serial('id').primaryKey(),
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    flag: varchar('flag', { length: 1 }).notNull(), // 'Y' | 'N'
    regionCode: varchar('region_code', { length: 10 }).notNull(),
    sourceFileKey: varchar('source_file_key', { length: 500 }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    isbnIdx: index('idx_gardners_market_restrictions_isbn').on(t.isbn13),
    isbnRegionUnique: uniqueIndex('uq_gardners_market_restrictions_isbn_region').on(
      t.isbn13,
      t.regionCode,
    ),
    bookIdIdx: index('idx_gardners_market_restrictions_book_id').on(t.bookId),
  }),
);

export type GardnersRegion = typeof gardnersRegions.$inferSelect;
export type NewGardnersRegion = typeof gardnersRegions.$inferInsert;
export type GardnersMarketRestriction = typeof gardnersMarketRestrictions.$inferSelect;
export type NewGardnersMarketRestriction = typeof gardnersMarketRestrictions.$inferInsert;
