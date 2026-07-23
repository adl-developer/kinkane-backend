import { pgTable, serial, integer, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

// Types that already have a producer wired up. `friend_request` notifications
// are not stored here — they're a live view over `follow_requests` (see
// notifications.service.ts) since that table is already the source of truth
// for pending/accepted/declined state.
export const notificationTypes = ['post_like', 'post_comment'] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(),
    data: jsonb('data').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userCreatedIdx: index('idx_notifications_user_created').on(t.userId, t.createdAt),
    userUnreadIdx: index('idx_notifications_user_unread').on(t.userId, t.readAt),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
