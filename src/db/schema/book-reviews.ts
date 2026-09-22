/**
 * Review quotes from NielsenIQ BookData Online — owned and migrated here;
 * populated by the nielsen-reviews cron and by on-demand lookups from
 * books.service's getById.
 */
import { pgTable, serial, varchar, text, integer, timestamp, date, index } from 'drizzle-orm/pg-core';

/**
 * One row per ISBN we have asked Nielsen about.
 *
 * A row with reviewHtml NULL means "asked, they had nothing" — measured at
 * ~70% of a catalogue sample. Recording the miss is what stops every visitor
 * to a reviewless book spending another record of the daily quota on it.
 */
export const bookReviews = pgTable(
  'book_reviews',
  {
    id: serial('id').primaryKey(),
    isbn13: varchar('isbn13', { length: 13 }).notNull().unique(),
    // Stored as supplied: Nielsen returns escaped HTML with the outlet names
    // embedded in the prose ("... * Observer *"), not as separate fields.
    // Kept raw to match how ONIX long descriptions are already handled.
    reviewHtml: text('review_html'),
    // Which territory variant supplied the text — NBDFREV, AUSFREV or NZFREV.
    // Only one is ever populated per record, and which one depends on the
    // dataset configuration, so it is worth recording what we actually got.
    sourceField: varchar('source_field', { length: 16 }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Drives the batch job's "misses due for a re-check" half of its candidate
    // query; the isbn13 unique constraint already covers lookups by ISBN.
    checkedAtIdx: index('idx_book_reviews_checked_at').on(t.checkedAt),
  }),
);

/**
 * Daily spend against the Nielsen record quota, one row per day.
 *
 * Nielsen publishes no quota endpoint and returns no usage figures, so this
 * table is the only account we have of what we have spent. It lives in the
 * database rather than in memory because the quota is per-account, not
 * per-process: web dynos, the cron and any worker all draw on the same 1,000
 * records/day, and in cluster mode the cron runs in every worker at once.
 *
 * Batch and on-demand are counted separately so the nightly job cannot eat
 * the allowance reserved for visitors.
 */
export const nielsenApiUsage = pgTable('nielsen_api_usage', {
  day: date('day').primaryKey(),
  batchUsed: integer('batch_used').notNull().default(0),
  onDemandUsed: integer('on_demand_used').notNull().default(0),
  // Set when Nielsen itself answers resultCode 50 (LIMITS_EXCEEDED). Our own
  // counters are an estimate — this is the authoritative "stop for today",
  // and is respected regardless of what the counters say.
  limitHitAt: timestamp('limit_hit_at', { withTimezone: true }),
});

export type BookReview = typeof bookReviews.$inferSelect;
export type NielsenApiUsage = typeof nielsenApiUsage.$inferSelect;
