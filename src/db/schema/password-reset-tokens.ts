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
 * One row per in-flight password reset request.
 * The raw token is never stored — only its SHA-256 hex hash.
 * Expires in 1 hour. Deleted on use or when a newer request is made.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 hex of the raw token sent to the client — same pattern as refresh_tokens
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_password_reset_tokens_user_id').on(t.userId),
  }),
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
