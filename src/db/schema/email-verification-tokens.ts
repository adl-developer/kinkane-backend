import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One row per in-flight signup email-verification request.
 * The raw token is never stored — only its SHA-256 hex hash.
 * Expires in 24 hours. Deleted on use or when a newer request is made.
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 hex of the raw token sent to the client — same pattern as password_reset_tokens
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_email_verification_tokens_user_id').on(t.userId),
  }),
);

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
