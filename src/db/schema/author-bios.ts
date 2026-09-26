/**
 * One biography per author, derived from the per-book biographies BDS supply.
 *
 * BDS have no author identifier, so the only key available is the name. That
 * is also the danger: two different people share a name, and serving one
 * person's biography on the other's page is the exact failure that ruled out
 * building this from Wikipedia. `confidence` is how that is contained — see
 * services/author-bios.service.ts.
 */
import { pgTable, varchar, text, date, integer, timestamp, index } from 'drizzle-orm/pg-core';

/** 'high' = every book by this name agrees. 'ambiguous' = they do not; serve nothing. */
export const AUTHOR_BIO_CONFIDENCE = ['high', 'ambiguous'] as const;
export type AuthorBioConfidence = (typeof AUTHOR_BIO_CONFIDENCE)[number];

export const authorBios = pgTable(
  'author_bios',
  {
    /**
     * The author's name with whitespace collapsed and trimmed, lowercased —
     * the same normalisation author search uses (lib/contributor-name), because
     * 22% of contributor rows arrive with doubled internal spaces and a raw
     * key would split one author in two.
     */
    normalisedName: varchar('normalised_name', { length: 500 }).primaryKey(),
    /** The name as the feed spells it, for display. */
    displayName: varchar('display_name', { length: 500 }).notNull(),
    bioHtml: text('bio_html').notNull(),
    /** The book this biography came from, and when that book was published. */
    sourceIsbn13: varchar('source_isbn13', { length: 13 }),
    sourcePubDate: date('source_pub_date'),
    /** BDS's own last-changed date for that record (yyyymmdd). */
    sourceUpdated: varchar('source_updated', { length: 8 }),
    confidence: varchar('confidence', { length: 16 }).$type<AuthorBioConfidence>().notNull().default('high'),
    /**
     * How many of this author's books were considered. A name with many books
     * and one agreed biography is stronger evidence than a single book.
     */
    booksConsidered: integer('books_considered').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The author endpoint and the "does this author have a bio" flag both read
    // by confidence, and only 'high' rows are ever served.
    confidenceIdx: index('idx_author_bios_confidence').on(t.confidence),
  }),
);

export type AuthorBio = typeof authorBios.$inferSelect;
