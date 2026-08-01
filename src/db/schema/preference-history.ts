import {
  pgTable,
  serial,
  integer,
  varchar,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users, readerTypeEnum } from './users';
import type { Dislikes } from './onboarding';

// ── User Preference History ───────────────────────────────────────────────────
// Append-only audit log of every preference change a user has ever made.
// `user_preferences` remains the authoritative current state — this table is
// purely additive and no read path depends on it.
//
// Each row is a FULL snapshot rather than a diff, so answering "what did this
// user like in March?" is a single indexed read with no replay. `changedFields`
// carries the diff view on top of the snapshot for callers that want it.
//
// The preference embedding is deliberately NOT stored here: 768 floats per row
// would multiply this table's size ~10x for something that can always be
// regenerated from the snapshot.

/** Why a history row was written. */
export type PreferenceChangeSource = 'onboarding' | 'user_edit' | 'system';

/** Snapshot fields that `changedFields` can name. */
export type PreferenceHistoryField =
  | 'feelings'
  | 'bookIds'
  | 'genres'
  | 'dislikes'
  | 'dislikedBookIds'
  | 'readerType';

export const userPreferenceHistory = pgTable(
  'user_preference_history',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feelings: jsonb('feelings').$type<string[]>().notNull(),
    bookIds: jsonb('book_ids').$type<number[]>().notNull(),
    genres: jsonb('genres').$type<string[]>().notNull(),
    dislikes: jsonb('dislikes').$type<Dislikes>().notNull(),
    // Every book the user had rejected as of this snapshot. Denormalized from
    // user_disliked_books (which is the authoritative, append-only store) so a
    // history row stays a self-contained picture of the taste profile — the
    // same reason readerType is carried forward below. Defaults to an empty
    // array so rows written before dislikes existed read back cleanly.
    dislikedBookIds: jsonb('disliked_book_ids').$type<number[]>().notNull().default([]),
    // Carried forward from users.reader_type so each row is a self-contained
    // picture of the taste profile, even though reader type is written on a
    // different code path than the rest of these fields.
    readerType: readerTypeEnum('reader_type'),
    // Which fields differed from the previous history row. Empty only for the
    // very first row of a user, where everything is new by definition.
    changedFields: jsonb('changed_fields').$type<PreferenceHistoryField[]>().notNull(),
    source: varchar('source', { length: 50 }).$type<PreferenceChangeSource>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Serves both the per-user timeline read and the retention cron's
    // "latest row per user" subquery.
    userRecordedIdx: index('idx_user_pref_history_user_recorded').on(t.userId, t.recordedAt),
  }),
);

export type UserPreferenceHistory = typeof userPreferenceHistory.$inferSelect;
export type NewUserPreferenceHistory = typeof userPreferenceHistory.$inferInsert;
