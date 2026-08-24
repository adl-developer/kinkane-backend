import {
  pgTable,
  serial,
  varchar,
  char,
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
    // E.164, or null — most accounts never supply one. Collected at checkout
    // as a delivery contact and editable from the profile screen; it is not an
    // identity or a login factor, and nothing authenticates against it.
    phone: varchar('phone', { length: 32 }),
    shelfVisibility: shelfVisibilityEnum('shelf_visibility').notNull().default('public'),
    readerType: readerTypeEnum('reader_type'),
    // ── Competition geography ──────────────────────────────────────────────
    // ISO 3166-1 alpha-2, resolved once at signup and then immutable except by
    // an admin correction. Deliberately not re-resolved on later logins: a user
    // who travels must not silently move country mid-competition, and a field
    // that drifts underneath the leaderboard is impossible to reason about.
    //
    // No foreign key to `countries` on purpose — a geo lookup can return a code
    // the seed doesn't carry (AQ, or user-assigned codes like XK), and an FK
    // would turn that into a failed signup. Unrecognised codes simply score
    // nothing.
    countryCode: char('country_code', { length: 2 }),
    // How country_code was determined: 'header' (trusted CDN geo header),
    // 'maxmind' (local GeoLite2 lookup), 'admin' (manual correction), or
    // 'unknown'. Kept so the accuracy of the signal can be audited later
    // without guessing which path produced any given row.
    countrySource: varchar('country_source', { length: 20 }),
    countryResolvedAt: timestamp('country_resolved_at', { withTimezone: true }),
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
