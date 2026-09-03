import { eq, and, sql, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import {
  books,
  bookContributors,
  userPreferences,
  userBooks,
  users,
  notificationPreferences,
  recommendationEmailLog,
  userDislikedBooks,
} from '../db/schema';
import {
  buildHasAuthorCondition,
  buildWorkExclusionCondition,
  getUserExclusions,
} from '../lib/exclusions';
import { buildFeedCondition } from './books.service';
import { enqueueEmail } from '../lib/email-queue';
import { enqueuePush } from '../lib/push-queue';
import { config } from '../config';
import { logger } from '../lib/logger';

const SIMILARITY_THRESHOLD = 0.5;

// 24-hour cooldown on the manual-refresh path so rapid re-refreshes don't flood the user
const REFRESH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface UnsentRecommendation {
  bookId: number;
  title: string;
  author: string;
}

/**
 * Runs a pgvector similarity search against the user's preference embedding,
 * excluding books already on their shelf, books we have already emailed them,
 * books they have rejected, and anything with no named author. Returns the top
 * match, or null if the pool is exhausted.
 *
 * Rejected books matter more here than anywhere else: an unwanted book in a
 * feed is a scroll past, the same book in an unprompted email is us not
 * listening.
 */
export async function pickUnsentRecommendation(userId: number): Promise<UnsentRecommendation | null> {
  const [prefs] = await db
    .select({ preferenceEmbedding: userPreferences.preferenceEmbedding })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  if (!prefs?.preferenceEmbedding) return null;

  const vectorLiteral = `[${prefs.preferenceEmbedding.join(',')}]`;

  // Work-level exclusions can't be expressed as a join on book_id — they match
  // other editions of a rejected book — so they come in as a WHERE predicate.
  const exclusions = await getUserExclusions(userId);
  const workExclusion = buildWorkExclusionCondition(exclusions.works);

  // Single query: LEFT JOIN exclusions let Postgres filter on indexed columns
  // rather than building a potentially large NOT IN (...) list client-side.
  // userBooks and recommendationEmailLog are joined with the userId condition
  // pushed into the ON clause so the NULL check correctly identifies non-matches
  // rather than rows where the book exists for a different user.
  const [top] = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .leftJoin(
      userBooks,
      and(eq(userBooks.bookId, books.id), eq(userBooks.userId, userId)),
    )
    .leftJoin(
      recommendationEmailLog,
      and(eq(recommendationEmailLog.bookId, books.id), eq(recommendationEmailLog.userId, userId)),
    )
    .leftJoin(
      userDislikedBooks,
      and(eq(userDislikedBooks.bookId, books.id), eq(userDislikedBooks.userId, userId)),
    )
    .where(
      and(
        sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${SIMILARITY_THRESHOLD}`,
        isNull(userBooks.bookId),
        isNull(recommendationEmailLog.bookId),
        isNull(userDislikedBooks.bookId),
        workExclusion,
        // Withdrawn and unsellable titles are never emailed out. Same argument
        // as the author check below, only stronger: this pick is unprompted, and
        // an email recommending a book that turns out to be unbuyable spends the
        // reader's trust on a dead end. Shared with every feed's predicate so
        // the two cannot disagree about what sellable means.
        buildFeedCondition(),
        // An email whose subject line names a book with no author is worse
        // than no email at all — this is the one surface where the pick is
        // unprompted, so a broken-looking record has nowhere to hide.
        buildHasAuthorCondition(),
      ),
    )
    .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
    .limit(1);

  if (!top) return null;

  // Named contributors only. The predicate above guarantees the book has *an*
  // author, not that the lowest-sequence A01 row is the one carrying the name —
  // a book credited with a nameless A01 at sequence 1 and a real author at
  // sequence 2 would otherwise be emailed out as "Unknown".
  const [contributor] = await db
    .select({ personName: bookContributors.personName })
    .from(bookContributors)
    .where(
      and(
        eq(bookContributors.bookId, top.id),
        eq(bookContributors.role, 'A01'),
        isNotNull(bookContributors.personName),
        sql`btrim(${bookContributors.personName}) <> ''`,
      ),
    )
    .orderBy(bookContributors.sequenceNumber)
    .limit(1);

  return {
    bookId: top.id,
    title: top.title,
    author: contributor?.personName ?? 'Unknown',
  };
}

/**
 * Sends a recommendation email to the user if an unsent book exists in their
 * pool, then records it in the log and updates last_recommendation_sent_at.
 * Returns true if an email was sent, false if the pool was exhausted.
 */
export async function sendRecommendationEmail(
  userId: number,
  userEmail: string,
  userName: string,
): Promise<boolean> {
  const pick = await pickUnsentRecommendation(userId);
  if (!pick) return false;

  await enqueueEmail('new-recommendation', {
    to: userEmail,
    name: userName,
    book: {
      title: pick.title,
      author: pick.author,
      reason: "Based on your reading preferences, we think you'll enjoy this one.",
      url: `${config.appUrl}/books/${pick.bookId}`,
    },
  });

  enqueuePush('new-recommendation', {
    userId,
    bookId: pick.bookId,
    bookTitle: pick.title,
  }).catch((err) => logger.error('Failed to enqueue recommendation push', { err, userId }));

  const now = new Date();

  await Promise.all([
    db
      .insert(recommendationEmailLog)
      .values({ userId, bookId: pick.bookId })
      .onConflictDoNothing(),
    db
      .update(notificationPreferences)
      .set({ lastRecommendationSentAt: now, updatedAt: now })
      .where(eq(notificationPreferences.userId, userId)),
  ]);

  return true;
}

/**
 * Called after a manual recommendations refresh. Sends a recommendation email
 * only if the newBookSuggestions preference is on and at least 24 hours have
 * passed since the last recommendation email (prevents repeated refreshes from
 * spamming the user).
 */
export async function maybeSendRecommendationAfterRefresh(userId: number): Promise<void> {
  const [notifPrefs] = await db
    .select({
      newBookSuggestions: notificationPreferences.newBookSuggestions,
      lastRecommendationSentAt: notificationPreferences.lastRecommendationSentAt,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);

  if (!notifPrefs?.newBookSuggestions) return;

  const lastSent = notifPrefs.lastRecommendationSentAt;
  if (lastSent && Date.now() - lastSent.getTime() < REFRESH_COOLDOWN_MS) return;

  const [userRow] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) return;

  await sendRecommendationEmail(userId, userRow.email, userRow.name).catch((err) => {
    logger.error('Failed to send recommendation email after refresh', {
      userId,
      error: (err as Error).message,
    });
  });
}
