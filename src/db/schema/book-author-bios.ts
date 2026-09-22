/**
 * Author biographies from BDS (Bibliographic Data Services) — owned and
 * migrated here; populated by the bds-enrichment cron and by on-demand
 * lookups from books.service's getById.
 */
import { pgTable, serial, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * One row per ISBN we have asked BDS about.
 *
 * Keyed by ISBN, not by contributor, for two reasons. BDS supply the bio per
 * book (one block of HTML that may cover several contributors), not per
 * person, and carry no author identifier to hang it on. And book_contributors
 * rows are deleted and re-created on every ONIX ingest, so a foreign key to
 * them would be broken within a week.
 *
 * A row with bioHtml NULL means "asked, BDS had nothing", exactly as in
 * book_reviews. This table is also BDS's lookup ledger: the nightly sweep
 * picks books with no row here, so it must be written even on a miss.
 */
export const bookAuthorBios = pgTable(
  'book_author_bios',
  {
    id: serial('id').primaryKey(),
    isbn13: varchar('isbn13', { length: 13 }).notNull().unique(),
    // Stored as supplied — BDS send HTML in CDATA (e.g. "<p><strong>Name</strong>
    // graduated from ..."), handled like ONIX long descriptions.
    bioHtml: text('bio_html'),
    // Which BDS field it came from: 'author_bio' (preferred) or
    // 'biographical_note' (the ONIX note, used when author_bio is empty).
    sourceField: varchar('source_field', { length: 32 }),
    // BDS's own last-changed date (yyyymmdd). Lets the daily change pass skip
    // records we already hold at this version.
    sourceUpdated: varchar('source_updated', { length: 8 }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Drives the sweep's "misses due for a re-check" half.
    checkedAtIdx: index('idx_book_author_bios_checked_at').on(t.checkedAt),
  }),
);

export type BookAuthorBio = typeof bookAuthorBios.$inferSelect;
