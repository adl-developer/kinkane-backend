import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const emailChangeRequests = pgTable(
  'email_change_requests',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    newEmail: varchar('new_email', { length: 500 }).notNull(),
    // SHA-256 hex of the 6-digit OTP — never store raw
    otpHash: varchar('otp_hash', { length: 64 }).notNull(),
    // SHA-256 hex of the cancel token sent to the old email
    cancelTokenHash: varchar('cancel_token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_email_change_requests_user_id').on(t.userId),
  }),
);

export type EmailChangeRequest = typeof emailChangeRequests.$inferSelect;
