/**
 * Book-related tables — owned by the server (migrations run here).
 * The onix_ingester service reads/writes these tables but does NOT migrate
 * them. (This comment previously said the opposite — that was stale
 * documentation left over from before migration ownership moved to the
 * server in May 2026; see ingestion.ts, render.yaml's db:init
 * preDeployCommand, and onix_ingester's own removed drizzle.config.ts for
 * the actual convention.)
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  date,
  primaryKey,
  customType,
  index,
} from 'drizzle-orm/pg-core';

// pgvector type — mirrors onix_ingester definition. Exported for use in other schema files.
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return config ? `vector(${config.dimensions})` : 'vector';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value.replace(/^\[|\]$/g, '').split(',').map(Number);
  },
});

// tsvector type — maintained by DB trigger, never written from app
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const books = pgTable(
  'books',
  {
    id: serial('id').primaryKey(),
    recordReference: varchar('record_reference', { length: 100 }).notNull().unique(),
    isbn13: varchar('isbn13', { length: 13 }).unique(),
    notificationType: varchar('notification_type', { length: 2 }),
    productForm: varchar('product_form', { length: 10 }),
    productComposition: varchar('product_composition', { length: 2 }),
    editionNumber: integer('edition_number'),
    pageCount: integer('page_count'),
    heightMm: numeric('height_mm', { precision: 7, scale: 2 }),
    widthMm: numeric('width_mm', { precision: 7, scale: 2 }),
    thicknessMm: numeric('thickness_mm', { precision: 7, scale: 2 }),
    weightGr: numeric('weight_gr', { precision: 9, scale: 2 }),
    countryOfManufacture: varchar('country_of_manufacture', { length: 2 }),
    productClassificationCode: varchar('product_classification_code', { length: 30 }),
    title: varchar('title', { length: 2000 }).notNull(),
    subtitle: varchar('subtitle', { length: 2000 }),
    shortDescription: text('short_description'),
    longDescription: text('long_description'),
    publisherName: varchar('publisher_name', { length: 500 }),
    imprintName: varchar('imprint_name', { length: 500 }),
    countryOfPublication: varchar('country_of_publication', { length: 2 }),
    publishingStatus: varchar('publishing_status', { length: 2 }),
    publicationDate: date('publication_date'),
    availabilityCode: varchar('availability_code', { length: 2 }),
    returnsCode: varchar('returns_code', { length: 10 }),
    orderTime: integer('order_time'),
    searchVector: tsvector('search_vector'),
    embedding: vector('embedding', { dimensions: 768 }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    coverUrl: varchar('cover_url', { length: 500 }),
    coverFetchedAt: timestamp('cover_fetched_at', { withTimezone: true }),
    // Set only by Gardners' cover full-catalogue probe (gardners-cover-sync.service.ts
    // in onix_ingester), independent of coverFetchedAt (which the Google Books
    // fallback owns) — lets Google Books act as a true last resort: it only
    // considers a book once Gardners has already checked and found nothing.
    gardnersCoverCheckedAt: timestamp('gardners_cover_checked_at', { withTimezone: true }),
    // Set when Gardners sends an ONIX "delete" notification (notificationType
    // '05') for this recordReference — a title withdrawn from their
    // catalogue. The ingestion pipeline used to hard-delete the row for
    // this, which cascaded to a user's posts/reviews, reading-list entries,
    // and interaction history for that book; this flag lets those survive.
    // Cleared automatically if a normal (non-delete) notification for the
    // same recordReference arrives later (e.g. the title is reissued).
    isRemoved: boolean('is_removed').notNull().default(false),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    // The book's primary genre, denormalised from the publisher's own
    // <MainSubject/> nomination — the scheme-93 row in book_subjects carrying
    // is_main_subject — rather than derived at read time. It only changes when
    // ingestion rewrites the book's subjects, so it belongs on the row.
    //
    // Nullable, and a large part of the catalogue is expected to stay null:
    // measured on production 2026-09-04, 1,415,382 of 2,029,071 live books
    // carry that flag, and 54,805 have no Thema data at all. Every consumer
    // has to render a book that has no main genre.
    //
    // Deliberately NOT the most frequent of the book's genres: Thema codes are
    // hierarchical, so the commonest genre attached to a book is always its
    // broadest ancestor (a title tagged NH/NHD/NHTB would resolve to "History"
    // over "European history"), and that rule disagrees with the publisher's
    // own nomination on 37% of books.
    mainGenreId: integer('main_genre_id').references(() => genres.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    isbnIdx: index('idx_books_isbn13').on(t.isbn13),
    titleIdx: index('idx_books_title').on(t.title),
    publisherIdx: index('idx_books_publisher').on(t.publisherName),
    availabilityIdx: index('idx_books_availability').on(t.availabilityCode),
    isRemovedIdx: index('idx_books_is_removed').on(t.isRemoved),
    // Supports GET /books' default (no q/sort) ORDER BY updated_at LIMIT/OFFSET
    updatedAtIdx: index('idx_books_updated_at').on(t.updatedAt),
    // Supports trending()'s fallback ORDER BY publication_date DESC LIMIT — without
    // this, that query was a full parallel sequential scan + sort of the whole table.
    publicationDateIdx: index('idx_books_publication_date').on(t.publicationDate),
    // Serves GET /books?mainGenre=: the equality on main_genre_id and the
    // list's default ordering in one scan, so a filtered page needs no sort
    // step. Three details make that work, and each was measured rather than
    // assumed — get any of them wrong and the index still gets used, but a
    // Sort node reappears on top of it.
    //
    // Column order: a single-column index on main_genre_id alone would still
    // sort every page.
    //
    // Ascending updated_at, with no direction modifier: the default listing
    // sorts on a bare `books.updatedAt` (buildSortOrderBy in
    // services/books.service.ts), which is ASC. A DESC index — or an ASC one
    // spelled `DESC NULLS LAST` — describes a different ordering and the
    // planner sorts anyway. The other sortBy modes ride their own indexes and
    // are expected to sort here; this covers the default path only.
    //
    // The WHERE clause: every list path pushes `is_removed = false` (see
    // buildWhereClause), and without it in the index the planner bitmap-ANDs
    // this with idx_books_is_removed — bitmap scans lose ordering, so the sort
    // comes back. Partial also keeps the index off withdrawn titles, which no
    // listing can return anyway.
    //
    // Built CONCURRENTLY ahead of the migration by build-concurrent-indexes.ts;
    // on ~2M rows a plain build takes a SHARE lock long enough to stall the
    // ONIX pipeline and any Gardners feed run.
    mainGenreIdx: index('idx_books_main_genre')
      .on(t.mainGenreId, t.updatedAt)
      .where(sql`${t.isRemoved} = false`),
    // idx_books_title is still what a plain title lookup uses, but it no longer
    // orders GET /books?sortBy=title: that page sorts on a placeholder-title
    // rank before the title (see buildSortOrderBy in services/books.service.ts),
    // which only idx_books_title_sortable / _desc can satisfy. Both are created
    // in migration 0056 rather than here because drizzle-kit cannot express an
    // expression index; the CASE in that migration and the one in the service
    // have to stay character-identical or the planner matches neither.
  }),
);

export const bookContributors = pgTable(
  'book_contributors',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number'),
    role: varchar('role', { length: 10 }),
    personName: varchar('person_name', { length: 500 }),
    personNameInverted: varchar('person_name_inverted', { length: 500 }),
  },
  (t) => ({
    bookIdIdx: index('idx_book_contributors_book_id').on(t.bookId),
  }),
);

export const genres = pgTable('genres', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 300 }).notNull(),
  slug: varchar('slug', { length: 300 }).notNull().unique(),
  subjectCode: varchar('subject_code', { length: 50 }),
  schemeIdentifier: varchar('scheme_identifier', { length: 10 }),
});

export const bookGenres = pgTable(
  'book_genres',
  {
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    genreId: integer('genre_id')
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.bookId, t.genreId] }),
    genreIdIdx: index('idx_book_genres_genre_id').on(t.genreId),
  }),
);

export const bookSubjects = pgTable(
  'book_subjects',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    schemeIdentifier: varchar('scheme_identifier', { length: 10 }),
    schemeVersion: varchar('scheme_version', { length: 10 }),
    subjectCode: varchar('subject_code', { length: 50 }),
    subjectHeadingText: varchar('subject_heading_text', { length: 500 }),
    isMainSubject: boolean('is_main_subject').default(false),
  },
  (t) => ({
    bookIdIdx: index('idx_book_subjects_book_id').on(t.bookId),
  }),
);

export const bookPrices = pgTable(
  'book_prices',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    priceType: varchar('price_type', { length: 2 }),
    priceAmount: numeric('price_amount', { precision: 12, scale: 2 }),
    currencyCode: varchar('currency_code', { length: 3 }),
    taxRateCode: varchar('tax_rate_code', { length: 2 }),
    taxRatePercent: numeric('tax_rate_percent', { precision: 6, scale: 2 }),
  },
  (t) => ({
    bookIdIdx: index('idx_book_prices_book_id').on(t.bookId),
  }),
);

export type Book = typeof books.$inferSelect;
export type BookContributor = typeof bookContributors.$inferSelect;
export type Genre = typeof genres.$inferSelect;
export type BookSubject = typeof bookSubjects.$inferSelect;
export type BookPrice = typeof bookPrices.$inferSelect;
