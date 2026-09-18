import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgEnum,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

// tsvector type — the column is GENERATED ALWAYS in the migration, never
// written from the app. Same shape as the declarations in users.ts/books.ts;
// it has to be declared here or the schema-vs-database column diff in
// endpoints.contract.test.ts reports search_vector as an undeclared column.
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Public groups can be joined by anyone. Private groups are invite-only.
 *
 * Private means *unjoinable*, not *secret*: a non-member can still see a
 * private group's name, image, description, owner and creation date — the
 * design shows exactly that, and a locked "you need an invite" state would be
 * unreachable if private groups were hidden from discovery. Only the member
 * list and the ability to act are withheld.
 */
export const groupPrivacyEnum = pgEnum('group_privacy', ['public', 'private']);

/**
 * A user's relationship with a group.
 *
 *   invited   — someone in the group asked them in; not yet a member.
 *   requested — reserved. Request-to-join is not built (the design is
 *               invite-only), but the value ships now because extending a
 *               Postgres enum later is a separate non-transactional statement,
 *               and reserving it makes that feature a code change with no
 *               migration.
 *   active    — a member. The owner holds one of these too.
 *
 * There is deliberately no `declined`: declining an invite DELETES the row.
 * This diverges from follow_requests, which keeps declined rows and revives
 * them on re-send. Nothing in the design consumes a declined state, and
 * keeping the row would force every re-invite to be an UPDATE-or-INSERT
 * against the unique pair index below. Deleting makes re-invite a plain
 * insert; abuse is the invite rate limiter's job, not the schema's.
 */
export const groupMembershipStatusEnum = pgEnum('group_membership_status', [
  'invited',
  'requested',
  'active',
]);

export const groups = pgTable(
  'groups',
  {
    id: serial('id').primaryKey(),
    // Cascade: deleting an account deletes the groups it owns. The alternative
    // — auto-transferring to some other member — silently makes someone the
    // owner of a community they never volunteered to run. Cascade also keeps
    // owner_id non-nullable, so every authorization check stays a plain column
    // comparison instead of a nullable branch.
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    photoUrl: varchar('photo_url', { length: 500 }),
    privacy: groupPrivacyEnum('privacy').notNull().default('public'),
    // Denormalized member count. "34 users joined" appears on five list
    // surfaces; counting per row is either N+1 or a GROUP BY that defeats the
    // ranked-ORDER-BY-then-LIMIT shape the search formula depends on. Every
    // membership write updates this in the same transaction, funnelled through
    // two helpers in groups.service.ts so there is one place to get it wrong.
    memberCount: integer('member_count').notNull().default(0),
    searchVector: tsvector('search_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index('idx_groups_owner_id').on(t.ownerId),
    // The GIN indexes backing search (search_vector, and name for
    // word_similarity) are created by hand in the migration — drizzle-kit
    // cannot emit USING GIN or gin_trgm_ops.
    memberCountNonNegative: check('groups_member_count_non_negative', sql`${t.memberCount} >= 0`),
  }),
);

export const groupMemberships = pgTable(
  'group_memberships',
  {
    id: serial('id').primaryKey(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: groupMembershipStatusEnum('status').notNull(),
    // Who sent the invite. SET NULL rather than cascade: the membership must
    // outlive the inviter's account.
    invitedBy: integer('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One relationship per (group, user). This is the concurrency guard that
    // makes a batched insert...onConflictDoNothing() safe, the same role the
    // sender/receiver index plays for follow_requests.
    groupUserUniq: uniqueIndex('idx_group_memberships_group_user').on(t.groupId, t.userId),
    userStatusIdx: index('idx_group_memberships_user_status').on(t.userId, t.status),
    groupStatusIdx: index('idx_group_memberships_group_status').on(t.groupId, t.status),
    // joined_at is set exactly when the row becomes active, in both directions
    // — so member_count can never be reconciled against a half-written row.
    joinedAtConsistency: check(
      'group_memberships_joined_at_consistency',
      sql`(${t.status} = 'active') = (${t.joinedAt} IS NOT NULL)`,
    ),
    // A request-to-join has no inviter by definition.
    invitedByDirection: check(
      'group_memberships_invited_by_direction',
      sql`${t.status} <> 'requested' OR ${t.invitedBy} IS NULL`,
    ),
  }),
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;
export type GroupMembership = typeof groupMemberships.$inferSelect;
export type GroupPrivacy = (typeof groupPrivacyEnum.enumValues)[number];
export type GroupMembershipStatus = (typeof groupMembershipStatusEnum.enumValues)[number];
