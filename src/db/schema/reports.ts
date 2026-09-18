import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  varchar,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { posts } from './community';
import { groups } from './groups';

/**
 * Where a report ended up. `pending` is the moderation queue; the other two are
 * done. Declared here rather than in schema/admin.ts because the column lives
 * on this table — the other way round makes the two files import each other,
 * and Drizzle evaluates them at module load.
 */
export const reportStatusEnum = pgEnum('report_status', ['pending', 'resolved', 'dismissed']);

/**
 * What a report is filed against.
 *
 * Added when groups became reportable. A discriminator rather than a second
 * nullable id with no flag: the shape CHECK below can then state exactly which
 * columns each kind must and must not carry, and the moderation queue can
 * filter by kind without inferring it from which column happens to be null.
 */
export const reportTargetTypeEnum = pgEnum('report_target_type', ['user', 'group']);

// A report is kept even if the post it was filed against is later deleted —
// postId is nulled out rather than cascading the report away.
export const userReports = pgTable(
  'user_reports',
  {
    id: serial('id').primaryKey(),
    reporterId: integer('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Defaulted so rows written before groups were reportable — and any caller
    // that still omits it — remain correct without a backfill.
    targetType: reportTargetTypeEnum('target_type').notNull().default('user'),
    // Nullable since a group report has no individual to attach. The shape
    // CHECK is what keeps it present for every user report.
    reportedUserId: integer('reported_user_id').references(() => users.id, { onDelete: 'cascade' }),
    // SET NULL, not cascade: deleting a reported group must not erase the
    // complaint about it, the same way postId keeps the report when a post goes.
    reportedGroupId: integer('reported_group_id').references(() => groups.id, { onDelete: 'set null' }),
    postId: integer('post_id').references(() => posts.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    // Customer-facing-ish identity for the moderation queue: the console shows
    // "R003", not a database id. Generated from the id at read time would break
    // the moment rows are deleted, so it is stored.
    reference: varchar('reference', { length: 16 }),
    status: reportStatusEnum('status').notNull().default('pending'),
    // Which admin closed it, and when. No FK — see the note on users.blacklistedBy.
    resolvedBy: integer('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The queue view is "pending first, newest first".
    statusIdx: index('idx_user_reports_status').on(t.status),
    referenceIdx: uniqueIndex('idx_user_reports_reference').on(t.reference),
    reportedUserIdIdx: index('idx_user_reports_reported_user_id').on(t.reportedUserId),
    reporterIdIdx: index('idx_user_reports_reporter_id').on(t.reporterId),
    postIdIdx: index('idx_user_reports_post_id').on(t.postId),
    reportedGroupIdIdx: index('idx_user_reports_reported_group_id').on(t.reportedGroupId),
    targetTypeIdx: index('idx_user_reports_target_type').on(t.targetType),
    // A user report must name a user and no group; a group report must name no
    // user. It deliberately does NOT require reported_group_id to be present:
    // ON DELETE SET NULL nulls that column when a reported group is deleted,
    // and demanding NOT NULL would make deleting a reported group fail on this
    // constraint.
    targetShape: check(
      'user_reports_target_shape',
      sql`(${t.targetType} = 'user' AND ${t.reportedUserId} IS NOT NULL AND ${t.reportedGroupId} IS NULL)
          OR (${t.targetType} = 'group' AND ${t.reportedUserId} IS NULL)`,
    ),
    // Unchanged by the nullable reported_user_id: a CHECK fails only on FALSE,
    // and `42 != NULL` is NULL, which passes. Group reports are unaffected.
    notSelfReportCheck: check('user_reports_not_self_check', sql`${t.reporterId} != ${t.reportedUserId}`),
  }),
);

export type UserReport = typeof userReports.$inferSelect;
export type NewUserReport = typeof userReports.$inferInsert;
