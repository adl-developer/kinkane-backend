import { eq, and, sql, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  books,
  bookContributors,
  userPreferences,
  userBooks,
  users,
  notificationPreferences,
  recommendationEmailLog,
} from '../db/schema';
import { enqueueEmail } from '../lib/email-queue';
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
 * excluding books already on their shelf and books we have already emailed them.
 * Returns the top match, or null if the pool is exhausted.
 */
export async function pickUnsentRecommendation(userId: number): Promise<UnsentRecommendation | null> {
  const [prefs] = await db
    .select({ preferenceEmbedding: userPreferences.preferenceEmbedding })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  if (!prefs?.preferenceEmbedding) return null;

  const vectorLiteral = `[${prefs.preferenceEmbedding.join(',')}]`;

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
    .where(
      and(
        sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${SIMILARITY_THRESHOLD}`,
        isNull(userBooks.bookId),
        isNull(recommendationEmailLog.bookId),
      ),
    )
    .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
    .limit(1);

  if (!top) return null;

  const [contributor] = await db
    .select({ personName: bookContributors.personName })
    .from(bookContributors)
    .where(and(eq(bookContributors.bookId, top.id), eq(bookContributors.role, 'A01')))
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
