import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android']);

/**
 * One row per registered device/app install. A token is unique to a device,
 * not a user — re-registering an existing token (e.g. a different account
 * signing in on the same phone) reassigns it via upsert rather than erroring.
 */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fcmToken: text('fcm_token').notNull().unique(),
    platform: devicePlatformEnum('platform').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_device_tokens_user_id').on(t.userId),
  }),
);

export type DeviceToken = typeof deviceTokens.$inferSelect;
export type NewDeviceToken = typeof deviceTokens.$inferInsert;
