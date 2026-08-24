import {
  pgTable, serial, varchar, text, timestamp, integer, boolean, index, pgEnum,
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
 * and password, no self-service signup, no password reset. Admins are created
 * with `npm run admin:create`.
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('idx_admins_email').on(t.email),
  }),
);

export type Admin = typeof admins.$inferSelect;

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
