import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { posts } from '../db/schema';
import { logger } from '../lib/logger';

/**
 * The caller's own rating and review of a book — their community post for it.
 *
 * A reader has at most one post per book (idx_posts_user_book), so this is
 * either that post or null. Private posts are included: it is the caller's own
 * review being shown back to them, not someone else's.
 *
 * Matched on the exact book id, not the work. A review of the paperback is not
 * shown against the hardback — editions are grouped by title heuristics (see
 * lib/dedupe), not a stored work id, and a guess here would put a review on a
 * book the reader never reviewed.
 */
export interface MyReview {
  /** The post's id — what the community edit/delete routes take. */
  postId: number;
  rating: number;
  status: 'reading' | 'read';
  body: string | null;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WithMyReview<T> = T & { myReview: MyReview | null };

/**
 * Never throws. The review is decoration on a response whose real content (the
 * books) has already loaded, so a failed lookup degrades to "no review" rather
 * than turning a working search or shelf into a 500 — the same call the book
 * page makes for public notes.
 */
async function getMyReviews(userId: number, bookIds: number[]): Promise<Map<number, MyReview>> {
  const ids = [...new Set(bookIds)];
  if (ids.length === 0) return new Map();

  try {
    return await queryMyReviews(userId, ids);
  } catch (err) {
    logger.warn('Could not load the reader\'s own reviews; returning books without them', {
      userId,
      bookCount: ids.length,
      error: (err as Error).message,
    });
    return new Map();
  }
}

async function queryMyReviews(userId: number, ids: number[]): Promise<Map<number, MyReview>> {
  const rows = await db
    .select({
      bookId: posts.bookId,
      postId: posts.id,
      rating: posts.rating,
      status: posts.status,
      body: posts.body,
      isPublic: posts.isPublic,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
    })
    .from(posts)
    .where(and(eq(posts.userId, userId), inArray(posts.bookId, ids)));

  return new Map(rows.map(({ bookId, ...review }) => [bookId, review]));
}

/**
 * Adds `myReview` to every item: the caller's rating and review of that book,
 * or null. Signed-out callers get null on every item without a query, so the
 * response shape is the same either way.
 *
 * Done per request, after any cache — the listings themselves are shared
 * between readers and must never carry one reader's review.
 */
export async function withMyReviews<T>(
  userId: number | undefined,
  items: T[],
  bookIdOf: (item: T) => number,
): Promise<WithMyReview<T>[]> {
  const reviews = userId ? await getMyReviews(userId, items.map(bookIdOf)) : new Map<number, MyReview>();
  return items.map((item) => ({ ...item, myReview: reviews.get(bookIdOf(item)) ?? null }));
}

/** withMyReviews for a single book. */
export async function getMyReview(userId: number | undefined, bookId: number): Promise<MyReview | null> {
  if (!userId) return null;
  return (await getMyReviews(userId, [bookId])).get(bookId) ?? null;
}
