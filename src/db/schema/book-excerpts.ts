import { pgTable, serial, varchar, boolean, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * One row per Jellybooks excerpt, keyed by isbn13.
 * Owned and migrated here; populated by onix_ingester's excerpt-sync job.
 */
export const bookExcerpts = pgTable(
  'book_excerpts',
  {
    id: serial('id').primaryKey(),
    isbn13: varchar('isbn13', { length: 13 }).notNull().unique(),
    title: varchar('title', { length: 2000 }),
    url: varchar('url', { length: 500 }),
    available: boolean('available').notNull().default(true),
    // Jellybooks' own update timestamp, distinct from our fetchedAt/updatedAt
    jbUpdatedAt: timestamp('jb_updated_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    isbnIdx: index('idx_book_excerpts_isbn13').on(t.isbn13),
  }),
);

export type BookExcerpt = typeof bookExcerpts.$inferSelect;
