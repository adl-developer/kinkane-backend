import {
  pgTable,
  serial,
  varchar,
  integer,
  real,
  uuid,
  jsonb,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, readerTypeEnum } from './users';
import { books, vector } from './books';

// Shared shape for the dislikes object used in both guest sessions and user preferences.
// Exported so recommendations.service.ts can import the canonical type.
//
// Deliberately open: the categories and the labels inside them are owned by the
// onboarding UI, not by this schema. Whatever the client sends is stored and fed
// into the preference text as-is, so the frontend can add, rename or reword a
// category without a backend deploy. The categories in use at the time of writing
// are emotionalTone, contentSensitivity, pacingStructure, writingStyle, genreFocus
// and commitmentLevel, but nothing here depends on that list.
export type Dislikes = Record<string, string[]>;

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
    // Books the user swiped away on that same recommendation list. Held here
    // only until registration, when migrateGuestSession copies them into
    // user_disliked_books — a guest has no user row to hang them off yet.
    dislikedBookIds: jsonb('disliked_book_ids').$type<number[]>(),
    readerType: readerTypeEnum('reader_type'),
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
    // 768-dim Gemini text-embedding-004 vector built from preference text.
    // Null until migrateGuestSession completes the async embedding call.
    preferenceEmbedding: vector('preference_embedding', { dimensions: 768 }),
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
    // 'view' | 'like' | 'want_to_read' | 'reading' | 'read' | 'purchase' |
    // 'high_rating' | 'chosen_from_recommendation'
    // See INTERACTION_TYPES / INTERACTION_WEIGHTS in services/interactions.service.ts,
    // which owns what each type is worth to the trending feed.
    type: varchar('type', { length: 50 }).notNull(),
    // Relative importance of this signal — higher = stronger influence on future recommendations
    weight: real('weight').notNull().default(1.0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_user_interactions_user_id').on(t.userId),
    bookIdIdx: index('idx_user_interactions_book_id').on(t.bookId),
    typeIdx: index('idx_user_interactions_type').on(t.type),
    // Supports the trending query, which now also filters on type:
    //   WHERE created_at > NOW()-30d AND type IN (...) GROUP BY book_id
    // Column order matters — created_at leads because it's the range predicate, and
    // type before book_id lets the whole scan stay index-only.
    trendingIdx: index('idx_user_interactions_trending').on(t.createdAt, t.type, t.bookId),
    // Caps every non-view signal at one row per user per book, permanently. This is
    // what makes like → unlike → like farming worth exactly one row. Views are
    // excluded because they're meant to recur over time; they're rate-limited in
    // Redis instead (see VIEW_DEDUPE_TTL).
    uniqueNonView: uniqueIndex('idx_user_interactions_unique_non_view')
      .on(t.userId, t.bookId, t.type)
      .where(sql`${t.type} <> 'view'`),
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
    // 'want_to_read' | 'reading' | 'read' — null means no reading status has been set
    status: varchar('status', { length: 20 }),
    // 'chosen_from_onboarding' | 'manual' | 'recommended'
    source: varchar('source', { length: 50 }).notNull().default('manual'),
    // Optional note the user writes about the book (max 1000 chars enforced at API layer)
    note: text('note'),
    // When true the note is visible to all users on the book detail page
    noteIsPublic: boolean('note_is_public').notNull().default(false),
    // User has explicitly liked this book (independent of reading status)
    liked: boolean('liked').notNull().default(false),
    likedAt: timestamp('liked_at', { withTimezone: true }),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_user_books_user_id').on(t.userId),
    bookIdIdx: index('idx_user_books_book_id').on(t.bookId),
    uniqueUserBook: uniqueIndex('idx_user_books_user_book').on(t.userId, t.bookId),
  }),
);

export type GuestSession = typeof guestSessions.$inferSelect;
export type NewGuestSession = typeof guestSessions.$inferInsert;
export type UserPreference = typeof userPreferences.$inferSelect;
export type UserInteraction = typeof userInteractions.$inferSelect;
export type UserBook = typeof userBooks.$inferSelect;
