import {
  pgTable,
  serial,
  varchar,
  integer,
  real,
  uuid,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';

// Shared shape for the dislikes object used in both guest sessions and user preferences.
// Exported so recommendations.service.ts can import the canonical type.
export interface Dislikes {
  emotionalTone?: string[];
  pacingStructure?: string[];
  writingStyle?: string[];
  genreFocus?: string[];
  commitmentLevel?: string[];
}

// ── Guest Sessions ─────────────────────────────────────────────────────────────
// Temporary record created at the end of the onboarding flow (after the user
// picks their 5 books). Lives for GUEST_SESSION_TTL_HOURS, then gets cleaned
// up by the cron job. Migrated to proper user tables on account creation.

export const guestSessions = pgTable(
  'guest_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    feelings: jsonb('feelings').$type<string[]>().notNull(),
    // Books the user said they've already read / enjoyed (up to 10)
    bookIds: jsonb('book_ids').$type<number[]>().notNull(),
    genres: jsonb('genres').$type<string[]>().notNull(),
    dislikes: jsonb('dislikes').$type<Dislikes>().notNull(),
    // The 5 books the user chose from the recommendation results.
    // Null until the client calls POST /guest-sessions/:id/selections.
    chosenBookIds: jsonb('chosen_book_ids').$type<number[]>(),
    // Ties back to recommendation_cache.input_hash so we can retrieve the result if needed
    recommendationHash: varchar('recommendation_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index('idx_guest_sessions_expires_at').on(t.expiresAt),
  }),
);

// ── User Preferences ───────────────────────────────────────────────────────────
// Migrated from the guest session on account creation. One record per user.
// Stores the raw structured preferences (not the embedding — that lives on users.preference_embedding).

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' })
      .unique(),
    feelings: jsonb('feelings').$type<string[]>().notNull(),
    // Books they said they enjoyed during onboarding
    bookIds: jsonb('book_ids').$type<number[]>().notNull(),
    genres: jsonb('genres').$type<string[]>().notNull(),
    dislikes: jsonb('dislikes').$type<Dislikes>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // No extra index needed — the .unique() on userId already creates a B-tree index.
);

// ── User Interactions ─────────────────────────────────────────────────────────
// Behavioural signals used to tune future recommendation embeddings.
// Seeded at registration from the 5 onboarding choices, then grows over time.

export const userInteractions = pgTable(
  'user_interactions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // 'view' | 'purchase' | 'high_rating' | 'wishlist' | 'chosen_from_recommendation'
    type: varchar('type', { length: 50 }).notNull(),
    // Relative importance of this signal — higher = stronger influence on future recommendations
    weight: real('weight').notNull().default(1.0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_user_interactions_user_id').on(t.userId),
    bookIdIdx: index('idx_user_interactions_book_id').on(t.bookId),
    typeIdx: index('idx_user_interactions_type').on(t.type),
  }),
);

// ── User Books (Reading List) ─────────────────────────────────────────────────
// The user's personal bookshelf. Seeded at registration from the 5 chosen books.

export const userBooks = pgTable(
  'user_books',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // 'want_to_read' | 'reading' | 'read'
    status: varchar('status', { length: 20 }).notNull().default('want_to_read'),
    // 'chosen_from_onboarding' | 'manual' | 'recommended'
    source: varchar('source', { length: 50 }).notNull().default('manual'),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_user_books_user_id').on(t.userId),
    uniqueUserBook: uniqueIndex('idx_user_books_user_book').on(t.userId, t.bookId),
  }),
);

export type GuestSession = typeof guestSessions.$inferSelect;
export type NewGuestSession = typeof guestSessions.$inferInsert;
export type UserPreference = typeof userPreferences.$inferSelect;
export type UserInteraction = typeof userInteractions.$inferSelect;
export type UserBook = typeof userBooks.$inferSelect;
