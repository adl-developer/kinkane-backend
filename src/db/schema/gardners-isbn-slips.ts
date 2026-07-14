/**
 * Gardners Books wholesaler feed ingestion tables — owned by the server
 * (migrations run here). The onix_ingester service reads/writes these
 * tables but does NOT migrate them.
 */
import { pgTable, varchar, timestamp, index } from 'drizzle-orm/pg-core';

// "Slipped" ISBNs — a title has been replaced by a new edition. oldIsbn13 is
// the primary key (the redirect source is unique by definition); newIsbn13 is
// indexed so a future lookup can also resolve "what old ISBNs map to this
// current one." Full weekly replace, no header/trailer in the source CSV.
export const gardnersIsbnSlips = pgTable(
  'gardners_isbn_slips',
  {
    oldIsbn13: varchar('old_isbn13', { length: 13 }).primaryKey(),
    newIsbn13: varchar('new_isbn13', { length: 13 }).notNull(),
    sourceFileKey: varchar('source_file_key', { length: 500 }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    newIsbnIdx: index('idx_gardners_isbn_slips_new_isbn').on(t.newIsbn13),
  }),
);

export type GardnersIsbnSlip = typeof gardnersIsbnSlips.$inferSelect;
export type NewGardnersIsbnSlip = typeof gardnersIsbnSlips.$inferInsert;
