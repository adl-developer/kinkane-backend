import { pgTable, serial, integer, varchar, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users, followRequests } from './users';

// Types that already have a producer wired up. `friend_request` rows go to the
// receiver and are kept in step with their `follow_requests` row by
// users.service.ts: written in the same transaction as the request, their
// `data.status` updated on accept/decline/resend, and deleted by the FK
// cascade when the request is withdrawn. Older requests were backfilled by
// 0072. Clearing a notification deletes its row, except a friend request still
// waiting on an answer, which can't be cleared.
export const notificationTypes = [
  'post_like',
  'post_comment',
  'group_invite',
  'friend_request',
  'follow_accepted',
  'new_recommendation',
  'mention',
] as const;
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
    // Set only on `friend_request` rows. Unique so there is exactly one
    // notification per request; NULLs don't collide, so other types are free.
    followRequestId: integer('follow_request_id').references(() => followRequests.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userCreatedIdx: index('idx_notifications_user_created').on(t.userId, t.createdAt),
    userUnreadIdx: index('idx_notifications_user_unread').on(t.userId, t.readAt),
    followRequestUniq: uniqueIndex('idx_notifications_follow_request_id').on(t.followRequestId),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
