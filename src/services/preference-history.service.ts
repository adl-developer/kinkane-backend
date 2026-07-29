import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db';
import { userPreferenceHistory, users } from '../db/schema';
import type {
  Dislikes,
  PreferenceChangeSource,
  PreferenceHistoryField,
  UserPreferenceHistory,
} from '../db/schema';
import type { ReaderType } from '../db/schema/users';

/**
 * Either the root db handle or an open transaction. Lets `record` join an
 * existing transaction (the onboarding path) or run standalone (the edit path).
 */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The preference fields carried in a history snapshot, minus reader type. */
export interface PreferenceSnapshotInput {
  feelings: string[];
  bookIds: number[];
  genres: string[];
  dislikes: Dislikes;
}

export interface RecordOptions {
  /**
   * Reader type to store. Omit to carry forward whatever is currently on the
   * user row — the usual case, since reader type is written on a different
   * code path than the rest of these fields.
   */
  readerType?: ReaderType | null;
  /** Transaction to run inside. Defaults to the root db handle. */
  tx?: DbHandle;
}

/**
 * Order-insensitive canonical form used only for change detection — never for
 * what gets stored. Reordering a genre list is not a preference change, and
 * without this every save would append a near-duplicate row.
 */
export function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return [...v].map(normalize).sort(compareCanonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .map(([k, val]) => [k, normalize(val)] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  };
  return JSON.stringify(normalize(value) ?? null);
}

function compareCanonical(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a) ?? 'null';
  const sb = JSON.stringify(b) ?? 'null';
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export const preferenceHistoryService = {
  /**
   * Appends a snapshot of the user's preferences to the history log.
   *
   * Returns the inserted row, or null when the snapshot is identical to the
   * previous one (a no-op save) — the log should record changes, not saves.
   *
   * Callers on the user-facing edit path should not let a failure here fail the
   * user's save; see the try/catch at the `saveUserPreferenceFields` call site.
   */
  async record(
    userId: number,
    prefs: PreferenceSnapshotInput,
    source: PreferenceChangeSource,
    options: RecordOptions = {},
  ): Promise<UserPreferenceHistory | null> {
    const handle: DbHandle = options.tx ?? db;

    // Carry the current reader type forward unless the caller supplied one, so
    // every row stays a self-contained picture of the taste profile.
    let readerType: ReaderType | null;
    if (options.readerType !== undefined) {
      readerType = options.readerType;
    } else {
      const [user] = await handle
        .select({ readerType: users.readerType })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      readerType = user?.readerType ?? null;
    }

    const [previous] = await handle
      .select()
      .from(userPreferenceHistory)
      .where(eq(userPreferenceHistory.userId, userId))
      .orderBy(desc(userPreferenceHistory.recordedAt), desc(userPreferenceHistory.id))
      .limit(1);

    const next = { ...prefs, readerType };
    let changedFields: PreferenceHistoryField[];

    if (previous) {
      const fields: PreferenceHistoryField[] = [
        'feelings',
        'bookIds',
        'genres',
        'dislikes',
        'readerType',
      ];
      changedFields = fields.filter(
        (f) => canonical(previous[f]) !== canonical(next[f]),
      );
      // Nothing actually changed — don't pollute the timeline.
      if (changedFields.length === 0) return null;
    } else {
      // First row for this user: everything is new by definition, so an empty
      // changedFields is the honest answer rather than listing all five.
      changedFields = [];
    }

    const [inserted] = await handle
      .insert(userPreferenceHistory)
      .values({
        userId,
        feelings: prefs.feelings,
        bookIds: prefs.bookIds,
        genres: prefs.genres,
        dislikes: prefs.dislikes,
        readerType,
        changedFields,
        source,
      })
      .returning();

    return inserted ?? null;
  },

  /** Newest-first page of a user's preference timeline. */
  async list(
    userId: number,
    { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
  ): Promise<{ items: UserPreferenceHistory[]; total: number }> {
    const [items, [{ count }]] = await Promise.all([
      db
        .select()
        .from(userPreferenceHistory)
        .where(eq(userPreferenceHistory.userId, userId))
        .orderBy(desc(userPreferenceHistory.recordedAt), desc(userPreferenceHistory.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(userPreferenceHistory)
        .where(eq(userPreferenceHistory.userId, userId)),
    ]);

    return { items, total: count };
  },

  /**
   * Deletes history rows older than `retentionYears`, except each user's most
   * recent row. Without that exemption a user who set their preferences once
   * and never touched them again would lose their entire history, leaving an
   * empty timeline for someone who still has live preferences.
   */
  async pruneOlderThan(retentionYears: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - retentionYears);

    // Written as raw SQL: the "keep the newest row per user" rule needs a
    // window function over the same table being deleted from, which the query
    // builder can't express without an outer alias it doesn't provide.
    const deleted = await db.execute<{ id: number }>(sql`
      DELETE FROM user_preference_history
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 recorded_at,
                 row_number() OVER (
                   PARTITION BY user_id
                   ORDER BY recorded_at DESC, id DESC
                 ) AS rn
          FROM user_preference_history
        ) ranked
        WHERE ranked.rn > 1
          AND ranked.recorded_at < ${cutoff}
      )
      RETURNING id
    `);

    return (deleted as unknown as { id: number }[]).length;
  },
};
