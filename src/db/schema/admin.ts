import {
  pgTable, serial, varchar, text, timestamp, integer, boolean, index, uniqueIndex, pgEnum,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { orders } from './commerce';
import { userReports } from './reports';

/**
 * Staff accounts for the admin console.
 *
 * A table of their own rather than a role flag on `users`, deliberately. This
 * console can blacklist a customer and export the entire customer list, and
 * keeping the two populations separate means no path through the customer-facing
 * auth stack — social login, password reset, email change, account merge — can
 * ever end with a customer holding admin rights. The blast radius of a bug in
 * the app's auth is customers only.
 *
 * The cost is a second login stack, which is why it is deliberately small: email
 * and password, an emailed password reset, and no self-service signup. Admins
 * are created with `npm run admin:create`.
 */
export const admins = pgTable(
  'admins',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 200 }).notNull(),
    email: varchar('email', { length: 254 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 500 }).notNull(),
    // Null until they first sign in. Shown in no UI today; it is here so a
    // dormant account is findable before it becomes a question.
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    // Soft disable — an admin who has left. Kept rather than deleted so their
    // name still resolves on the reports they resolved.
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    // Set whenever the password changes, by any route. A console session issued
    // before this moment is refused, so changing or resetting a password
    // actually evicts whoever else holds a session. Null = never changed since
    // this column existed, which revokes nothing.
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('idx_admins_email').on(t.email),
  }),
);

export type Admin = typeof admins.$inferSelect;

/**
 * In-flight "forgot password" requests for admins.
 *
 * Its own table rather than a row in `password_reset_tokens`, for the same
 * reason admins are not users: that table's `user_id` points at customers, and
 * a reset token that could be redeemed against the wrong population is exactly
 * the cross-over the separate `admins` table exists to rule out.
 *
 * Only the SHA-256 of the token is stored. One live token per admin, enforced
 * by the unique `admin_id` — issuing a new one overwrites the old in place, so
 * two requests at once cannot leave two working links.
 */
export const adminPasswordResetTokens = pgTable(
  'admin_password_reset_tokens',
  {
    id: serial('id').primaryKey(),
    adminId: integer('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    adminIdIdx: uniqueIndex('idx_admin_password_reset_tokens_admin_id').on(t.adminId),
  }),
);

/**
 * The two announcement strips at the top of every storefront page.
 *
 * A row per slot rather than a settings blob: there are exactly two, the design
 * names them, and each has the same three fields. `slot` is the primary key, so
 * the table cannot grow a third banner by accident.
 */
export const announcementBanners = pgTable('announcement_banners', {
  // 'top' is the red strip, 'second' the charcoal one beneath it.
  slot: varchar('slot', { length: 20 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  text: varchar('text', { length: 200 }).notNull(),
  updatedBy: integer('updated_by').references(() => admins.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type AnnouncementBanner = typeof announcementBanners.$inferSelect;

/** The four events the admin bell reports. */
export const adminNotificationTypeEnum = pgEnum('admin_notification_type', [
  'report_filed',
  'order_received',
  'customer_registered',
  'order_delivered',
]);

/**
 * The admin notification feed — the bell in the console header.
 *
 * Separate from the customer-facing `notifications` table on purpose: different
 * audience, different lifecycle, and nothing here should ever be at risk of
 * being rendered in the app.
 *
 * Read state is global rather than per-admin. With a handful of staff sharing
 * one queue, "Ama already dealt with that" is the useful behaviour, and a
 * per-admin join table would be more machinery than the feed is worth. Revisit
 * if the team grows.
 */
export const adminNotifications = pgTable(
  'admin_notifications',
  {
    id: serial('id').primaryKey(),
    type: adminNotificationTypeEnum('type').notNull(),
    // Rendered as-is. Written at emit time rather than composed on read, so a
    // notification still reads correctly after the thing it describes changes.
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    // Whichever of these the event concerns; all nullable. `set null` so
    // deleting the subject does not delete the history of it happening.
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'set null' }),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    reportId: integer('report_id').references(() => userReports.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The feed is always "newest first, unread first" — this backs both.
    createdAtIdx: index('idx_admin_notifications_created_at').on(t.createdAt),
    readAtIdx: index('idx_admin_notifications_read_at').on(t.readAt),
  }),
);

export type AdminNotification = typeof adminNotifications.$inferSelect;
