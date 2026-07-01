import { pgTable, serial, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  newBookSuggestions: boolean('new_book_suggestions').notNull().default(true),
  rateReviewReminders: boolean('rate_review_reminders').notNull().default(true),
  friendRequests: boolean('friend_requests').notNull().default(true),
  comments: boolean('comments').notNull().default(true),
  likes: boolean('likes').notNull().default(true),
  lastRecommendationSentAt: timestamp('last_recommendation_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
},
(t) => ({
  lastSentIdx: index('idx_notif_prefs_last_rec_sent').on(t.lastRecommendationSentAt),
}));

export type NotificationPreferences = typeof notificationPreferences.$inferSelect;
export type NewNotificationPreferences = typeof notificationPreferences.$inferInsert;
