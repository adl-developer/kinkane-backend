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
  customType,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const shelfVisibilityEnum = pgEnum('shelf_visibility', ['public', 'friends', 'private']);

export const readerTypeEnum = pgEnum('reader_type', [
  'The Open Door',
  'The Seeker',
  'The Book-ist',
  'The Story Circler',
  'The Mirror Within',
  'The Echo Collector',
  'The High Summiter',
  'The Cloud Illusionist',
]);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 500 }).notNull(),
    email: varchar('email', { length: 500 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 500 }),
    photoUrl: varchar('photo_url', { length: 1000 }),
    emailVerified: boolean('email_verified').default(false).notNull(),
    shelfVisibility: shelfVisibilityEnum('shelf_visibility').notNull().default('public'),
    readerType: readerTypeEnum('reader_type'),
    searchVector: tsvector('search_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('idx_users_email').on(t.email),
    searchVectorIdx: index('idx_users_search_vector').on(t.searchVector),
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

export const followRequestStatusEnum = pgEnum('follow_request_status', ['pending', 'accepted', 'declined']);

export const followRequests = pgTable(
  'follow_requests',
  {
    id: serial('id').primaryKey(),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    receiverId: integer('receiver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: followRequestStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    senderReceiverUniq: uniqueIndex('idx_follow_requests_sender_receiver').on(t.senderId, t.receiverId),
    receiverIdx: index('idx_follow_requests_receiver_id').on(t.receiverId),
    senderIdx: index('idx_follow_requests_sender_id').on(t.senderId),
  }),
);

export type ShelfVisibility = 'public' | 'friends' | 'private';
export type ReaderType = typeof readerTypeEnum.enumValues[number];
export type FollowRequestStatus = 'pending' | 'accepted' | 'declined';
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type UserProvider = typeof userProviders.$inferSelect;
export type FollowRequest = typeof followRequests.$inferSelect;
