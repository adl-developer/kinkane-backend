import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';

// ── User Disliked Books ───────────────────────────────────────────────────────
// Every book a user has explicitly rejected (swiped away on a recommendation
// list), accumulated across onboarding and every subsequent quiz. This is the
// negative counterpart to user_books.liked, and it is deliberately additive:
// rows are never deleted or replaced when the user retakes the quiz. Disliking
// the same book again bumps `dislikeCount` and `lastDislikedAt` instead of
// inserting a second row.
//
// Read on every personalized surface (quiz recommendations, the personalized
// feed, "you may also like", recommendation emails) to keep rejected books out.
//
// The normalized title/author snapshot exists because the catalogue holds many
// rows per work — hardback, paperback, reissue, each its own book_id. Excluding
// by book_id alone would let a different edition of a rejected book come
// straight back. Snapshotting at dislike time also means the exclusion still
// works if the book's contributor rows change under a later ONIX ingest.
// Books are soft-deleted (books.is_removed), never dropped, so the cascade
// below does not fire in practice.

export type DislikeSource = 'onboarding_selection' | 'quiz_refresh' | 'app';

export const userDislikedBooks = pgTable(
  'user_disliked_books',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // lower(btrim(title)) at the moment of the dislike. Matched against the
    // same expression over books.title to catch other editions of the work.
    titleNormalized: varchar('title_normalized', { length: 2000 }).notNull(),
    // lower(btrim(person_name)) of the first A01 contributor, or null when the
    // catalogue has no author for the book. Null means "match on title alone" —
    // see buildWorkExclusionCondition.
    authorNormalized: varchar('author_normalized', { length: 500 }),
    source: varchar('source', { length: 50 })
      .$type<DislikeSource>()
      .notNull()
      .default('app'),
    // How many separate times the user has rejected this book. A repeat
    // rejection is a stronger signal than a one-off, so it is counted rather
    // than collapsed.
    dislikeCount: integer('dislike_count').notNull().default(1),
    firstDislikedAt: timestamp('first_disliked_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastDislikedAt: timestamp('last_disliked_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Serves the "load this user's exclusion set" read, which runs on every
    // personalized feed request.
    userIdx: index('idx_user_disliked_books_user').on(t.userId),
    // Upsert target — one row per user per book, forever.
    uniqueUserBook: uniqueIndex('idx_user_disliked_books_user_book').on(t.userId, t.bookId),
  }),
);

export type UserDislikedBook = typeof userDislikedBooks.$inferSelect;
export type NewUserDislikedBook = typeof userDislikedBooks.$inferInsert;
