import { pgTable, serial, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export interface RecommendationItem {
  bookId: number;
  rank: number;
  explanation: string;
}

export const recommendationCache = pgTable(
  'recommendation_cache',
  {
    id: serial('id').primaryKey(),
    // SHA-256 hex of the normalised (sorted) input — used as the cache key
    inputHash: varchar('input_hash', { length: 64 }).notNull().unique(),
    // Ordered array of { bookId, rank, explanation }
    results: jsonb('results').$type<RecommendationItem[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    // hashIdx on inputHash is intentionally omitted — the .unique() above already
    // creates a B-tree index that the cache lookup uses. A second index would be wasted.
    expiresIdx: index('idx_rec_cache_expires_at').on(t.expiresAt),
  }),
);
