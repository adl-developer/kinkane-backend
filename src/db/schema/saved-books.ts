/**
 * "Saved Books" — the shop's purchase wishlist.
 *
 * Deliberately **not** the same thing as `user_books`, which is the reading
 * list: shelf status, likes and notes about books someone reads. This is
 * "I intend to buy this later", and the two answer different questions about
 * the same book — a person can own a copy they never want to buy again, and
 * want to buy one they have never read.
 *
 * The practical reason they are separate is access: liking a book on the
 * reading list is a Plus feature, and gating a customer's shopping wishlist
 * behind a subscription would mean asking people to pay before they are
 * allowed to want to spend money.
 *
 * Follows the same rule as the basket: nothing is stored for a signed-out
 * visitor. Guests keep their saved books on the client and replay them here
 * once they have an account.
 */
import { pgTable, serial, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';

export const savedBooks = pgTable(
  'saved_books',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Newest first is the only ordering the UI offers, and it is always scoped
    // to one user — so the index carries both.
    userIdIdx: index('idx_saved_books_user_id').on(t.userId, t.createdAt),
    // Saving twice is the same as saving once. This is what lets the endpoint
    // be a plain idempotent upsert rather than a read-then-write that two
    // rapid taps can race.
    uniqueUserBook: uniqueIndex('uq_saved_books_user_book').on(t.userId, t.bookId),
  }),
);

export type SavedBook = typeof savedBooks.$inferSelect;
export type NewSavedBook = typeof savedBooks.$inferInsert;
