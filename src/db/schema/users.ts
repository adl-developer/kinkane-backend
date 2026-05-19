import {
  pgTable,
  serial,
  varchar,
  boolean,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    fullName: varchar('full_name', { length: 500 }).notNull(),
    email: varchar('email', { length: 500 }).notNull().unique(),
    // Nullable to support OAuth-only accounts added later
    passwordHash: varchar('password_hash', { length: 500 }),
    emailVerified: boolean('email_verified').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('idx_users_email').on(t.email),
  }),
);

// Refresh tokens stored in DB so they can be invalidated on logout
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 hex of the raw token sent to the client — never store raw
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_refresh_tokens_user_id').on(t.userId),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
