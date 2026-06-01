import {
  pgTable,
  serial,
  varchar,
  boolean,
  timestamp,
  integer,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const shelfVisibilityEnum = pgEnum('shelf_visibility', ['public', 'friends', 'private']);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 500 }).notNull(),
    email: varchar('email', { length: 500 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 500 }),
    photoUrl: varchar('photo_url', { length: 1000 }),
    emailVerified: boolean('email_verified').default(false).notNull(),
    shelfVisibility: shelfVisibilityEnum('shelf_visibility').notNull().default('private'),
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

// Links a user to a Firebase social provider (google.com, facebook.com, apple.com)
export const userProviders = pgTable(
  'user_providers',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 50 }).notNull(),
    providerUid: varchar('provider_uid', { length: 256 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerUidUniq: uniqueIndex('idx_user_providers_provider_uid').on(t.provider, t.providerUid),
    userIdIdx: index('idx_user_providers_user_id').on(t.userId),
  }),
);

export type ShelfVisibility = 'public' | 'friends' | 'private';
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type UserProvider = typeof userProviders.$inferSelect;
