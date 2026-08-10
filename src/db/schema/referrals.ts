import {
  pgTable,
  serial,
  integer,
  varchar,
  char,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { subscriptionTierEnum } from './subscriptions';

// ── Referral codes ─────────────────────────────────────────────────────────────
// One active code per user, minted lazily the first time they open the invite
// screen rather than at signup — no reason to generate a code for every account
// that never shares one.
//
// Its own table rather than a column on `users` so a code can be rotated or
// revoked (abuse, or the user just wants a new one) without touching the user
// row, and so campaign codes with a null user_id fit later without a migration.
//
// The `slug` here is the *name slug at the time of minting*, kept only so the
// canonical link can be rebuilt server-side. It is never used to resolve a code:
// lookups are always by `code` alone, which is what lets a user rename
// themselves without breaking links already sitting in someone's WhatsApp.

export const referralCodes = pgTable(
  'referral_codes',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull().unique(),
    slug: varchar('slug', { length: 64 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    codeIdx: index('idx_referral_codes_code').on(t.code),
  }),
);

// ── Referral clicks ────────────────────────────────────────────────────────────
// Funnel numerator, and the only unauthenticated write path in this feature.
// Highest-volume table here by an order of magnitude, so: the IP is stored
// hashed rather than raw, and nothing in scoring reads this table — it exists
// for the click→signup conversion figure and nothing else.

export const referralClicks = pgTable(
  'referral_clicks',
  {
    id: serial('id').primaryKey(),
    codeId: integer('code_id')
      .notNull()
      .references(() => referralCodes.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 20 }),
    ipHash: varchar('ip_hash', { length: 64 }),
    userAgent: varchar('user_agent', { length: 500 }),
    countryCode: char('country_code', { length: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeIdx: index('idx_referral_clicks_code_id').on(t.codeId, t.createdAt),
  }),
);

// ── Referrals ──────────────────────────────────────────────────────────────────
// The edge table, and the thing the whole competition is computed from.
//
// `voided` is the only non-active state. An earlier design had signed_up →
// qualified gated on email verification, which was there to stop disposable
// inboxes farming a prize; with no prizes, points count at signup and the
// intermediate state had nothing left to represent.

export const referralStatusEnum = pgEnum('referral_status', ['active', 'voided']);

export const referrals = pgTable(
  'referrals',
  {
    id: serial('id').primaryKey(),
    referrerUserId: integer('referrer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // UNIQUE, and load-bearing: a user is referred exactly once, ever. That is
    // what makes this graph a forest of trees rather than an arbitrary digraph,
    // which in turn is what makes circuit detection a bounded walk up a single
    // known path instead of a cycle search.
    referredUserId: integer('referred_user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeId: integer('code_id').references(() => referralCodes.id, { onDelete: 'set null' }),
    clickId: integer('click_id').references(() => referralClicks.id, { onDelete: 'set null' }),
    status: referralStatusEnum('status').notNull().default('active'),
    channel: varchar('channel', { length: 20 }),
    // Distance from the root of this tree. 0 would be a root, which never has a
    // row here — the shallowest real row is depth 1.
    depth: integer('depth').notNull(),
    rootReferrerId: integer('root_referrer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Ordered ancestor user ids, root first, ending at the referrer. Computed
    // once at insert as `parent.ancestor_path || parent.referrer` and never
    // updated, because a node's parent never changes. This is what turns "is
    // there a circuit through this node" into an array read and "everyone under
    // user X" into a single GIN-indexed containment scan.
    ancestorPath: integer('ancestor_path').array().notNull(),
    // Both countries snapshotted at redemption. Snapshots rather than joins:
    // users travel and country can be corrected by an admin, and a live join
    // would silently restate the score of every past referral when they do.
    referrerCountry: char('referrer_country', { length: 2 }),
    redeemerCountry: char('redeemer_country', { length: 2 }),
    referrerTierAtReferral: subscriptionTierEnum('referrer_tier_at_referral'),
    signedUpAt: timestamp('signed_up_at', { withTimezone: true }).defaultNow().notNull(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: varchar('void_reason', { length: 200 }),
  },
  (t) => ({
    referrerIdx: index('idx_referrals_referrer_user_id').on(t.referrerUserId),
    rootIdx: index('idx_referrals_root_referrer_id').on(t.rootReferrerId),
    // Containment over the ancestor array — "every descendant of user X", any
    // depth, one index scan. A btree cannot serve @>.
    ancestorPathIdx: index('idx_referrals_ancestor_path').using('gin', t.ancestorPath),
    noSelfReferral: check('referrals_no_self_referral', sql`${t.referrerUserId} <> ${t.referredUserId}`),
  }),
);

// ── Referral points ────────────────────────────────────────────────────────────
// Append-only ledger. A user's score is a SUM over this table, never a counter
// on `users`: every point stays traceable to the referral that produced it, and
// a bad referral can be reversed by voiding its rows without recomputing anyone
// else's total.

export const referralPointKindEnum = pgEnum('referral_point_kind', [
  // Direct — your own code was redeemed.
  'same_country',              // 1
  'same_continent',            // 10
  'cross_continent',           // 20
  // Second degree — someone you referred referred them. Paid only for
  // geographic spread; a second-degree signup in your own country is worth
  // nothing, and nothing at all is paid beyond this generation.
  'indirect_same_continent',   // 5
  'indirect_cross_continent',  // 10
  'full_circuit',              // 30
]);

export const referralPointStateEnum = pgEnum('referral_point_state', ['counted', 'voided']);

export const referralPoints = pgTable(
  'referral_points',
  {
    id: serial('id').primaryKey(),
    // Who the points belong to — always the referrer/ancestor, never the
    // redeemer.
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Null for circuit awards: a circuit is earned by a path, not by any single
    // referral, so there is no one row to point at.
    referralId: integer('referral_id').references(() => referrals.id, { onDelete: 'cascade' }),
    kind: referralPointKindEnum('kind').notNull(),
    points: integer('points').notNull(),
    state: referralPointStateEnum('state').notNull().default('counted'),
    // The competition is currently unbounded, so everything lands in season 1.
    // Carried from the first migration anyway: adding it later would mean
    // backfilling a live points table and touching every scoring query, and
    // that asymmetry is lopsided enough to justify a column that does nothing
    // yet.
    seasonId: integer('season_id').notNull().default(1),
    awardedAt: timestamp('awarded_at', { withTimezone: true }).defaultNow().notNull(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: varchar('void_reason', { length: 200 }),
  },
  (t) => ({
    userIdx: index('idx_referral_points_user_id').on(t.userId, t.state),
    // Idempotency for the direct awards: re-running attribution for the same
    // referral can never double-pay.
    referralKindUniq: uniqueIndex('idx_referral_points_referral_kind').on(t.referralId, t.kind),
    // A circuit is once per user per season, enforced here rather than trusted
    // to the detection code being called exactly once. Partial, because
    // referral_id is null on these rows and NULLs are distinct under a plain
    // unique index — so the constraint above cannot cover them.
    circuitUniq: uniqueIndex('idx_referral_points_circuit')
      .on(t.userId, t.seasonId)
      .where(sql`${t.kind} = 'full_circuit'`),
  }),
);

export type ReferralCode = typeof referralCodes.$inferSelect;
export type ReferralClick = typeof referralClicks.$inferSelect;
export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
export type ReferralPoint = typeof referralPoints.$inferSelect;
export type ReferralPointKind = (typeof referralPointKindEnum.enumValues)[number];
export type ReferralStatus = (typeof referralStatusEnum.enumValues)[number];
