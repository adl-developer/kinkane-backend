import { sql, eq, and, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { books, bookContributors, userDislikedBooks } from '../db/schema';
import { redis } from './redis';
import { logger } from './logger';

/**
 * A book identified by the work it is, rather than by the catalogue row it
 * happens to be. `author` is null when the catalogue has no A01 contributor
 * for it, which downgrades the match to title-only.
 */
export interface ExcludedWork {
  title: string;
  author: string | null;
}

export interface UserExclusions {
  /** Exact catalogue rows to exclude — cheap, indexed. */
  bookIds: number[];
  /** Works to exclude regardless of which edition they show up as. */
  works: ExcludedWork[];
}

export const EMPTY_EXCLUSIONS: UserExclusions = { bookIds: [], works: [] };

/**
 * The one normalization used on both sides of every title/author comparison.
 * Must stay in lockstep with the SQL below (`lower(btrim(...))`) — if these two
 * ever disagree, exclusions silently stop matching.
 */
export function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Builds the "none of these works" predicate.
 *
 * Written as a single NOT EXISTS over a VALUES list rather than one AND'd
 * condition per work, so the query plan doesn't degrade as a user's dislike
 * list grows — a reader who has rejected 200 books gets the same shape of
 * query as one who has rejected 3.
 *
 * A work with a null author matches on title alone. That is the deliberate
 * looser branch: if we don't know who wrote the book the user rejected, not
 * re-recommending a same-titled book is the better error than recommending
 * the thing they just swiped away.
 *
 * Returns undefined for an empty list so callers can spread it into an
 * `and(...)` without a special case.
 */
export function buildWorkExclusionCondition(works: ExcludedWork[]): SQL | undefined {
  if (works.length === 0) return undefined;

  // The ::text casts are load-bearing, not decoration: these are bind
  // parameters inside a VALUES list, and Postgres cannot always infer a type
  // for an untyped parameter there — it fails the whole query with "could not
  // determine data type of parameter". Naming the type sidesteps the inference
  // entirely, and matters most in the all-null-author case where there is no
  // sibling row to infer from.
  const rows = works.map(
    (w) =>
      sql`(${normalizeForMatch(w.title)}::text, ${w.author === null ? null : normalizeForMatch(w.author)}::text)`,
  );

  return sql`NOT EXISTS (
    SELECT 1
    FROM (VALUES ${sql.join(rows, sql`, `)}) AS excluded_work(title, author)
    WHERE excluded_work.title = lower(btrim(${books.title}))
      AND (
        excluded_work.author IS NULL
        OR EXISTS (
          SELECT 1
          FROM book_contributors bc
          WHERE bc.book_id = ${books.id}
            AND bc.role = 'A01'
            AND lower(btrim(bc.person_name)) = excluded_work.author
        )
      )
  )`;
}

/**
 * The in-memory twin of `buildWorkExclusionCondition`, for lists that have
 * already been built and can't be re-queried — specifically the per-book
 * "you may also like" cache, which is shared across users and so can only be
 * filtered after it's read.
 *
 * Applies the identical rule: excluded by ID, or title matches and the author
 * matches too unless the rejection has no author recorded. Any divergence
 * between this and the SQL version is a bug in whichever one is wrong.
 */
export function filterExcludedWorks<
  T extends {
    id: number;
    title: string;
    // Both nullable in the catalogue — a contributor row can exist with no
    // role or no name.
    contributors: { role: string | null; personName: string | null }[];
  },
>(items: T[], exclusions: UserExclusions): T[] {
  if (exclusions.bookIds.length === 0 && exclusions.works.length === 0) return items;

  const excludedIds = new Set(exclusions.bookIds);

  // Grouped by title so each item is one map lookup rather than a scan of the
  // whole rejection list.
  const authorsByTitle = new Map<string, (string | null)[]>();
  for (const work of exclusions.works) {
    const authors = authorsByTitle.get(work.title) ?? [];
    authors.push(work.author);
    authorsByTitle.set(work.title, authors);
  }

  return items.filter((item) => {
    if (excludedIds.has(item.id)) return false;

    const excludedAuthors = authorsByTitle.get(normalizeForMatch(item.title));
    if (!excludedAuthors) return true;

    const itemAuthors = item.contributors
      .filter((c) => c.role === 'A01' && c.personName)
      .map((c) => normalizeForMatch(c.personName as string));

    return !excludedAuthors.some(
      (author) => author === null || itemAuthors.includes(author),
    );
  });
}

/**
 * Everything a user has rejected, in the shape the exclusion predicate wants.
 *
 * Redis-cached because this is read on every personalized feed request while
 * the underlying set changes only when the user swipes a book away — which is
 * also the only thing that busts it (see `bustUserExclusions`).
 *
 * Never throws: a Redis or Postgres hiccup here degrades to "no exclusions"
 * rather than failing the feed. The cost of that degradation is one unwanted
 * book in a list; the cost of throwing is an empty screen.
 */
export async function getUserExclusions(userId: number): Promise<UserExclusions> {
  const cacheKey = exclusionsCacheKey(userId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as UserExclusions;
  } catch (err) {
    logger.error('Failed to read exclusions cache', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const rows = await db
      .select({
        bookId: userDislikedBooks.bookId,
        title: userDislikedBooks.titleNormalized,
        author: userDislikedBooks.authorNormalized,
      })
      .from(userDislikedBooks)
      .where(eq(userDislikedBooks.userId, userId));

    const exclusions: UserExclusions = {
      bookIds: rows.map((r) => r.bookId),
      works: rows.map((r) => ({ title: r.title, author: r.author })),
    };

    await redis
      .set(cacheKey, JSON.stringify(exclusions), 'EX', EXCLUSIONS_TTL_SECONDS)
      .catch(() => undefined);

    return exclusions;
  } catch (err) {
    logger.error('Failed to load user exclusions', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_EXCLUSIONS;
  }
}

/**
 * Drops the cached exclusion set — call after any write to
 * user_disliked_books. Also clears the user's personalized feed, which is
 * built from these exclusions: without that, a book the user just swiped away
 * keeps showing up on the home feed until the feed's own TTL expires.
 */
export async function bustUserExclusions(userId: number): Promise<void> {
  try {
    await Promise.all([
      redis.del(exclusionsCacheKey(userId)),
      bustPersonalizedFeedCache(userId),
    ]);
  } catch (err) {
    logger.error('Failed to bust exclusions cache', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Busts the personalized feed cache for all limit variants. `limit` is bounded
 * to 1-20 by explore.controller's limitSchema, so we delete the exact bounded
 * key set directly rather than scanning the keyspace with KEYS — KEYS is an
 * O(N) blocking operation over the *entire* Redis instance and must never run
 * on a per-user write path.
 */
export async function bustPersonalizedFeedCache(userId: number): Promise<void> {
  const keys = Array.from(
    { length: PERSONALIZED_CACHE_MAX_LIMIT },
    (_, i) => `personalized:v1:${userId}:${i + 1}`,
  );
  await redis.del(...keys);
}

/**
 * Resolves book IDs to the normalized title/author snapshot stored alongside a
 * dislike. Shared by the guest-migration and logged-in write paths so both
 * store snapshots in exactly the same form.
 */
export async function resolveWorkSnapshots(
  bookIds: number[],
): Promise<Map<number, ExcludedWork>> {
  const snapshots = new Map<number, ExcludedWork>();
  if (bookIds.length === 0) return snapshots;

  const [bookRows, contributors] = await Promise.all([
    db.select({ id: books.id, title: books.title }).from(books).where(inArray(books.id, bookIds)),
    db
      .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
      .from(bookContributors)
      .where(and(inArray(bookContributors.bookId, bookIds), eq(bookContributors.role, 'A01')))
      .orderBy(bookContributors.sequenceNumber),
  ]);

  // First A01 contributor wins — sequence-ordered above, and the exclusion only
  // needs one author to anchor the match.
  const primaryAuthor = new Map<number, string>();
  for (const c of contributors) {
    if (c.personName && !primaryAuthor.has(c.bookId)) {
      primaryAuthor.set(c.bookId, c.personName);
    }
  }

  for (const row of bookRows) {
    const author = primaryAuthor.get(row.id);
    snapshots.set(row.id, {
      title: normalizeForMatch(row.title),
      author: author ? normalizeForMatch(author) : null,
    });
  }

  return snapshots;
}

const EXCLUSIONS_TTL_SECONDS = 60 * 60; // 1 hour — writes bust it explicitly

const PERSONALIZED_CACHE_MAX_LIMIT = 20;

function exclusionsCacheKey(userId: number): string {
  return `exclusions:v1:${userId}`;
}
