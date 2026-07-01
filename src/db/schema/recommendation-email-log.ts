import { pgTable, serial, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { books } from './books';

// One row per user+book combination — records every book we have emailed to a user
// so we never send the same recommendation twice, even across multiple cron cycles.
export const recommendationEmailLog = pgTable(
  'recommendation_email_log',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userBookUniq: uniqueIndex('idx_rec_email_log_user_book').on(t.userId, t.bookId),
  }),
);

export type RecommendationEmailLog = typeof recommendationEmailLog.$inferSelect;
