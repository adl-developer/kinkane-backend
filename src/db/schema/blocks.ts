import { pgTable, integer, varchar, timestamp, index, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

/**
 * One person blocking another. Apple requires it of any app with user content:
 * a way to stop someone seeing or engaging with you.
 *
 * One row per direction. A block is mutual in effect — neither person sees the
 * other in the feed or in search, and neither can tag or engage with the other
 * (see services/blocks.service.ts) — but only the blocker can lift it, so who
 * did it is recorded. If both block each other there are two rows, and each
 * has to unblock before the two can see each other again.
 *
 * Kept apart from user_reports on purpose: the client wanted blocking without a
 * report. The reason is for our own reading of why people block, not a
 * moderation queue; nothing acts on it.
 */
export const userBlocks = pgTable(
  'user_blocks',
  {
    blockerId: integer('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: integer('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // One of the app's reason options, or null if none was picked. Free text
    // rather than an enum so the app's list can change without a migration.
    reason: varchar('reason', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Leading on blocker_id, it also serves "who have I blocked".
    pk: primaryKey({ columns: [t.blockerId, t.blockedId], name: 'user_blocks_pkey' }),
    // The reverse lookup: who has blocked me.
    blockedIdx: index('idx_user_blocks_blocked_id').on(t.blockedId),
    notSelf: check('user_blocks_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
  }),
);

export type UserBlock = typeof userBlocks.$inferSelect;
