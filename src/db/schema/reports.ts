import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { posts } from './community';

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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reportedUserIdIdx: index('idx_user_reports_reported_user_id').on(t.reportedUserId),
    reporterIdIdx: index('idx_user_reports_reporter_id').on(t.reporterId),
    postIdIdx: index('idx_user_reports_post_id').on(t.postId),
    notSelfReportCheck: check('user_reports_not_self_check', sql`${t.reporterId} != ${t.reportedUserId}`),
  }),
);

export type UserReport = typeof userReports.$inferSelect;
export type NewUserReport = typeof userReports.$inferInsert;
