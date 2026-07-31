import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { userDislikedBooks, type DislikeSource } from '../db/schema';
import { bustUserExclusions, resolveWorkSnapshots } from '../lib/exclusions';
import { logger } from '../lib/logger';

/**
 * Either the root db handle or an open transaction, so the guest-migration
 * path can record dislikes inside the same transaction as the rest of signup.
 */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const dislikedBooksService = {
  /**
   * Records books the user rejected, adding to whatever they have rejected
   * before. Never replaces the existing set — retaking the quiz accumulates
   * dislikes rather than resetting them, which is the whole point of the
   * table. Re-rejecting a book already in the set bumps its counter and
   * timestamp instead of inserting a duplicate.
   *
   * Returns the number of book IDs recorded (including repeats).
   */
  async record(
    userId: number,
    bookIds: number[],
    source: DislikeSource,
    options: { tx?: DbHandle } = {},
  ): Promise<number> {
    const handle: DbHandle = options.tx ?? db;
    const uniqueIds = [...new Set(bookIds)];
    if (uniqueIds.length === 0) return 0;

    // Snapshot title/author now so the exclusion can catch other editions of
    // this work later, even if the catalogue shifts underneath us.
    const snapshots = await resolveWorkSnapshots(uniqueIds);

    // IDs with no matching catalogue row are dropped rather than inserted with
    // a placeholder title — a dislike we can't identify is worse than no
    // dislike, since an empty title would match nothing and a wrong one could
    // exclude an unrelated book.
    const values = uniqueIds
      .filter((bookId) => snapshots.has(bookId))
      .map((bookId) => {
        const snapshot = snapshots.get(bookId)!;
        return {
          userId,
          bookId,
          titleNormalized: snapshot.title,
          authorNormalized: snapshot.author,
          source,
        };
      });

    if (values.length < uniqueIds.length) {
      logger.warn('Ignored disliked book IDs with no catalogue row', {
        userId,
        ignored: uniqueIds.filter((id) => !snapshots.has(id)),
      });
    }

    if (values.length === 0) return 0;

    await handle
      .insert(userDislikedBooks)
      .values(values)
      .onConflictDoUpdate({
        target: [userDislikedBooks.userId, userDislikedBooks.bookId],
        set: {
          dislikeCount: sql`${userDislikedBooks.dislikeCount} + 1`,
          lastDislikedAt: new Date(),
          // Refresh the snapshot on a repeat dislike so a book whose catalogue
          // metadata has since been corrected gets the corrected form.
          titleNormalized: sql`excluded.title_normalized`,
          authorNormalized: sql`excluded.author_normalized`,
          source: sql`excluded.source`,
        },
      });

    await bustUserExclusions(userId);

    return values.length;
  },

  /** Every book ID this user has rejected, for the preferences read path. */
  async listBookIds(userId: number): Promise<number[]> {
    const rows = await db
      .select({ bookId: userDislikedBooks.bookId })
      .from(userDislikedBooks)
      .where(eq(userDislikedBooks.userId, userId));

    return rows.map((r) => r.bookId);
  },
};
