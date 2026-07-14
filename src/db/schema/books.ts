/**
 * Book-related tables — owned by the server (migrations run here).
 * The onix_ingester service reads/writes these tables but does NOT migrate
 * them. (This comment previously said the opposite — that was stale
 * documentation left over from before migration ownership moved to the
 * server in May 2026; see ingestion.ts, render.yaml's db:init
 * preDeployCommand, and onix_ingester's own removed drizzle.config.ts for
 * the actual convention.)
 */
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    isbnIdx: index('idx_books_isbn13').on(t.isbn13),
    titleIdx: index('idx_books_title').on(t.title),
    publisherIdx: index('idx_books_publisher').on(t.publisherName),
    availabilityIdx: index('idx_books_availability').on(t.availabilityCode),
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
