import { pgTable, serial, varchar, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Messages sent through the "Contact Us" form.
 *
 * Stored as well as emailed, deliberately. The email is the thing anyone
 * actually reads, but it is also the thing that silently fails — a bounced
 * webhook, a provider outage, a mistyped support address — and a customer who
 * wrote in and got no reply has no way to know their message evaporated. The
 * row is the receipt.
 *
 * There is no admin screen for these; the designs do not have one. This is a
 * safety net, not a feature.
 */
export const contactMessages = pgTable(
  'contact_messages',
  {
    id: serial('id').primaryKey(),
    // Null for someone writing in without an account, which is most of them.
    // `set null` rather than cascade: deleting an account should not destroy
    // the record of a support conversation that may still be open.
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 200 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    subject: varchar('subject', { length: 200 }).notNull(),
    message: text('message').notNull(),
    // Whether the notification email actually went out. False means the row is
    // the only copy and somebody has to go looking.
    emailed: timestamp('emailed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    createdAtIdx: index('idx_contact_messages_created_at').on(t.createdAt),
    emailIdx: index('idx_contact_messages_email').on(t.email),
  }),
);

export type ContactMessage = typeof contactMessages.$inferSelect;
