/**
 * Gardners Books wholesaler feed ingestion tables — owned by the server
 * (migrations run here). The onix_ingester service reads/writes these
 * tables but does NOT migrate them.
 */
import { pgTable, serial, integer, varchar, numeric, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { books } from './books';

// Current price + stock level per ISBN13, fed by both the daily Bespoke
// Inventory feed and the hourly Avail13 feed. One row per ISBN — stockUpdatedAt
// comes from the source file's own timestamp (not wall-clock), so whichever
// feed's file is actually newer wins regardless of which cron ran most recently.
// isbn13 (not bookId) is the natural key: this data can and does arrive for
// ISBNs that don't have a `books` row yet — bookId is backfilled after the fact.
export const gardnersStock = pgTable(
  'gardners_stock',
  {
    id: serial('id').primaryKey(),
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),

    rrpGbp: numeric('rrp_gbp', { precision: 10, scale: 2 }),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }),
    stockQty: integer('stock_qty'), // 0-1000; 1000 means "1000 or more"
    reportCode: varchar('report_code', { length: 10 }), // e.g. NYP, O/P, POS, M/D, CNC, R/P, GXC
    reportDate: date('report_date'),

    // 'inventory' | 'avail13_full' | 'avail13_delta' — which feed last wrote this row
    source: varchar('source', { length: 20 }).notNull(),
    sourceFileKey: varchar('source_file_key', { length: 500 }),
    stockUpdatedAt: timestamp('stock_updated_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    isbnUnique: uniqueIndex('uq_gardners_stock_isbn13').on(t.isbn13),
    bookIdIdx: index('idx_gardners_stock_book_id').on(t.bookId),
    stockUpdatedAtIdx: index('idx_gardners_stock_updated_at').on(t.stockUpdatedAt),
  }),
);

export type GardnersStock = typeof gardnersStock.$inferSelect;
export type NewGardnersStock = typeof gardnersStock.$inferInsert;
