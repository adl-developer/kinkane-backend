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

/**
 * Where a report ended up. `pending` is the moderation queue; the other two are
 * done. Declared here rather than in schema/admin.ts because the column lives
 * on this table — the other way round makes the two files import each other,
 * and Drizzle evaluates them at module load.
 */
export const reportStatusEnum = pgEnum('report_status', ['pending', 'resolved', 'dismissed']);

// A report is kept even if the post it was filed against is later deleted —
// postId is nulled out rather than cascading the report away.
export const userReports = pgTable(
  'user_reports',
  {
    id: serial('id').primaryKey(),
    reporterId: integer('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportedUserId: integer('reported_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    notSelfReportCheck: check('user_reports_not_self_check', sql`${t.reporterId} != ${t.reportedUserId}`),
  }),
);

export type UserReport = typeof userReports.$inferSelect;
export type NewUserReport = typeof userReports.$inferInsert;
