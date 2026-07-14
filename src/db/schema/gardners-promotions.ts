/**
 * Gardners Books wholesaler feed ingestion tables — owned by the server
 * (migrations run here). The onix_ingester service reads/writes these
 * tables but does NOT migrate them.
 */
import { pgTable, serial, integer, varchar, numeric, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { books } from './books';

// Mirrors the latest GARDPROM13.CSV exactly — a full daily replace. Rows are
// upserted with the current syncedAt on every run, then rows with a stale
// syncedAt (from before this run) are deleted — mark-and-sweep, since the
// source file is always a complete current snapshot, not a delta.
export const gardnersPromotions = pgTable(
  'gardners_promotions',
  {
    id: serial('id').primaryKey(),
    isbn13: varchar('isbn13', { length: 13 }).notNull(),
    bookId: integer('book_id').references(() => books.id, { onDelete: 'set null' }),

    // Kept from the feed itself (not joined from `books`) so unmatched rows
    // are still identifiable for debugging.
    title: varchar('title', { length: 2000 }),
    author: varchar('author', { length: 500 }),
    price: numeric('price', { precision: 10, scale: 2 }),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }),
    returnsFlag: varchar('returns_flag', { length: 1 }), // 'R' | 'F'
    finishDate: date('finish_date'),

    sourceFileKey: varchar('source_file_key', { length: 500 }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    isbnUnique: uniqueIndex('uq_gardners_promotions_isbn13').on(t.isbn13),
    bookIdIdx: index('idx_gardners_promotions_book_id').on(t.bookId),
    finishDateIdx: index('idx_gardners_promotions_finish_date').on(t.finishDate),
  }),
);

export type GardnersPromotion = typeof gardnersPromotions.$inferSelect;
export type NewGardnersPromotion = typeof gardnersPromotions.$inferInsert;
