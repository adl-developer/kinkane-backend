/**
 * Gardners Books wholesaler feed ingestion tables — owned by the server
 * (migrations run here). The onix_ingester service reads/writes these
 * tables but does NOT migrate them.
 */
import { pgTable, varchar, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { books } from './books';

// Pure ISBN membership table (~6M rows) — isbn13 is the primary key rather
// than a serial id since there's no other natural row identity. Full weekly
// replace, same mark-and-sweep semantics as gardners-promotions.
export const gardnersFirmSale = pgTable(
  'gardners_firm_sale',
  {
    isbn13: varchar('isbn13', { length: 13 }).primaryKey(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),
    reportCode: varchar('report_code', { length: 10 }),
    sourceFileKey: varchar('source_file_key', { length: 500 }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bookIdIdx: index('idx_gardners_firm_sale_book_id').on(t.bookId),
  }),
);

export type GardnersFirmSale = typeof gardnersFirmSale.$inferSelect;
export type NewGardnersFirmSale = typeof gardnersFirmSale.$inferInsert;
