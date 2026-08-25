import { pgTable, serial, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user notification switches.
 *
 * Two groups, and the split is what the one-click unsubscribe acts on:
 *
 *  - Promotional — `marketingEmails`, `newBookSuggestions`, `rateReviewReminders`.
 *    Email we send because we want the user back. Unsubscribe turns all three
 *    off at once (see routes/unsubscribe.routes.ts).
 *  - Everything else — `friendRequests`, `comments`, `likes`. Reactions to
 *    something the user or someone they know actually did. Unsubscribe leaves
 *    these alone; they are managed from the in-app settings screen.
 *
 * `comments` and `likes` gate push and the in-app feed only — social activity
 * deliberately never sends email at all (see services/community.service.ts).
 */
export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Promotional group — all three cleared by one-click unsubscribe.
  marketingEmails: boolean('marketing_emails').notNull().default(true),
  newBookSuggestions: boolean('new_book_suggestions').notNull().default(true),
  rateReviewReminders: boolean('rate_review_reminders').notNull().default(true),
  // Not promotional — never touched by unsubscribe.
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
