import {
  pgTable,
  serial,
  varchar,
  text,
  char,
  boolean,
  timestamp,
  integer,
  doublePrecision,
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
    // ── Guest accounts ─────────────────────────────────────────────────────
    // The web shop requires a Bearer token on every cart and checkout call, so
    // rather than show a login wall it silently signs the browser up on first
    // add-to-cart, with the name "Guest" and a `guest-<uuid>@guest.kinkane.app`
    // address. Those are ordinary accounts here — real password hash, real
    // session, even a Plus trial — and there were roughly ten of them for every
    // real signup, one per browser that ever opened the shop.
    //
    // Recorded as a column rather than re-derived from the email each time it
    // matters. The domain is a convention the *frontend* owns (see isGuestUser
    // in app/lib/auth-storage.ts); a query that pattern-matches on it is a
    // metric that breaks silently the day that string changes.
    //
    // This says how the account was created and nothing more. It is emphatically
    // not "does not count": a guest who completes a checkout is a real customer
    // with real revenue, which is why the admin console keys off
    // `countsAsCustomer` (has ordered, or is not a guest) rather than this flag
    // on its own.
    isGuest: boolean('is_guest').default(false).notNull(),
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
    // City, and the coordinates the globe plots.
    //
    // Country decides points; city decides nothing at all. It exists so the
    // journey reads as a journey — "Accra → Paris → Calcutta" rather than
    // "GH → FR → IN" — and so the globe has somewhere to put a pin. Nothing in
    // scoring may ever read these: they come from a coarser, more failure-prone
    // lookup than the country does, and a competition that turned on them would
    // be a competition decided by ISP routing.
    //
    // Unlike country_code, this one IS re-resolved on later logins, but only
    // while it is null. Existing accounts have no city and none can be derived
    // retroactively — the only IP we ever stored is a one-way hash — so
    // backfilling on next sight is the sole way this field ever populates for
    // them. Once set it is as immutable as country, for the same reason: a user
    // who travels must not migrate across the map mid-campaign.
    city: varchar('city', { length: 100 }),
    // City-centroid coordinates from the same lookup, stored so the globe does
    // not need a city→coordinates table of its own. Precision is deliberately
    // whatever GeoLite2 returns for the city — this is never a person's
    // location, it is the middle of a city they appeared to be near.
    cityLat: doublePrecision('city_lat'),
    cityLng: doublePrecision('city_lng'),
    citySource: varchar('city_source', { length: 20 }),
    // ── Blacklist ──────────────────────────────────────────────────────────
    // Set from the admin console, from either the Customers list or a report.
    // Null means in good standing; a timestamp means blocked. Stored as a time
    // rather than a boolean so "when did this happen" is answerable without an
    // audit table.
    //
    // What it blocks: signing in, and checking out. It deliberately does *not*
    // delete or hide their existing content — moderation is reversible and
    // destroying posts on a blacklist is not.
    blacklistedAt: timestamp('blacklisted_at', { withTimezone: true }),
    // No FK to `admins`: schema/users.ts is imported by nearly everything, and
    // pointing it at the admin table would make the customer schema depend on
    // the staff one. The id is enough to resolve a name when the console asks.
    blacklistedBy: integer('blacklisted_by'),
    blacklistReason: text('blacklist_reason'),
    // ── Activity ───────────────────────────────────────────────────────────
    // Last time this account was *seen*, not last time it typed a password.
    // Written on any authenticated request (throttled to once a day — see
    // touchLastSignIn in services/user-activity.service.ts) and directly on
    // sign-in, so it keeps meaning something for a mobile client that silently
    // rotates tokens for months and never re-authenticates.
    //
    // Backfilled to created_at for every account that existed before the column
    // did. That is a deliberate fiction — we never recorded sign-ins before, and
    // the alternative was a year of every customer reading "inactive" because
    // the field was null rather than because anybody was dormant. It decays out
    // of the data on its own as real activity overwrites it.
    //
    // Not null: the backfill covers the old rows and the default covers new
    // ones, so "we have never seen this user" is not a state that exists.
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }).defaultNow().notNull(),
    searchVector: tsvector('search_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('idx_users_email').on(t.email),
    searchVectorIdx: index('idx_users_search_vector').on(t.searchVector),
    // The admin console counts and filters on this on every Customers and
    // Overview load; without an index both become a seq scan over all users.
    lastSignInAtIdx: index('idx_users_last_sign_in_at').on(t.lastSignInAt),
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
