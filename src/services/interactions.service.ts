import { lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { userInteractions } from '../db/schema';
import { redis } from '../lib/redis';
import { logger } from '../lib/logger';

// ── Interaction types ─────────────────────────────────────────────────────────

/**
 * Every signal we know how to store. Not all of them are scored by the trending
 * feed — see TRENDING_SCORED_TYPES for that subset.
 *
 * 'purchase' and 'high_rating' are declared here because the column's comment has
 * always listed them, but nothing writes them yet.
 */
export const INTERACTION_TYPES = [
  'view',
  'like',
  'want_to_read',
  'reading',
  'read',
  'purchase',
  'high_rating',
  'chosen_from_recommendation',
] as const;

export type InteractionType = (typeof INTERACTION_TYPES)[number];

/**
 * How much each action counts toward a book's trending score.
 *
 * These are deliberately NOT ordered by "how much the user liked the book" alone —
 * they are ordered by intent *relative to how often the action happens*. A view is
 * a couple of orders of magnitude more common than a completed read, so scoring a
 * view anywhere near a read would turn trending into a raw pageview counter and
 * nothing else. Hence 0.25 for a view: present, but easily outweighed by a handful
 * of deliberate actions.
 *
 * Going down the funnel (view → want_to_read → reading → read) each step is rarer
 * and more committed, so each is worth more. The practical effect is that
 * want_to_read tends to *drive* the trending list because it is frequent and it is
 * how buzz shows up first, while read still counts properly on the rare occasions
 * it happens. Volume does the balancing, not the weights alone.
 *
 * IMPORTANT: these are applied at query time (see booksService.trending), not baked
 * into the stored row, precisely so they can be retuned by editing this map and
 * redeploying — no backfill of historical rows required.
 */
export const INTERACTION_WEIGHTS: Record<InteractionType, number> = {
  view: 0.25,
  like: 2,
  want_to_read: 3,
  reading: 4,
  read: 5,
  // Unscored today, but given sensible values so enabling them is a one-line change.
  purchase: 6,
  high_rating: 4,
  // Pre-existing signal, seeded at registration from onboarding picks. Left at its
  // historical value so turning trending on doesn't retroactively reweight old rows.
  chosen_from_recommendation: 1,
};

/** The subset of interaction types the trending feed actually scores. */
export const TRENDING_SCORED_TYPES: InteractionType[] = [
  'view',
  'like',
  'want_to_read',
  'reading',
  'read',
  'chosen_from_recommendation',
];

// ── Anti-gaming guards ────────────────────────────────────────────────────────

/**
 * How long a recorded view suppresses further view rows for the same
 * (user, book) pair.
 *
 * Without this, one user refreshing a book page sends it straight to the top of
 * trending. A 24h window would still let a single determined user contribute
 * 30 × 0.25 = 7.5 points over the trending window — more than a completed read,
 * which is clearly wrong. Seven days caps one user's view contribution to a single
 * book at roughly 1 point, which is the intent: no individual can move the list on
 * their own.
 */
export const VIEW_DEDUPE_TTL = 7 * 24 * 60 * 60; // 7 days

/**
 * Every non-view type is deduped in Postgres instead, by the partial unique index
 * `idx_user_interactions_unique_non_view` on (user_id, book_id, type). That makes
 * like → unlike → like farming worth exactly one row, permanently, without holding
 * a Redis key forever.
 *
 * Views can't use that index because they're intentionally repeatable over time,
 * so they get the Redis TTL guard above.
 */
export function isRedisDeduped(type: InteractionType): boolean {
  return type === 'view';
}

/** Redis key for the view guard. Exported for tests. */
export function viewDedupeKey(userId: number, bookId: number): string {
  return `interaction:view:${userId}:${bookId}`;
}

// ── Recording ─────────────────────────────────────────────────────────────────

export const interactionsService = {
  /**
   * Records a single interaction, applying the dedupe rules above.
   *
   * Returns true if a row was actually written, false if it was suppressed as a
   * duplicate. Callers on latency-sensitive paths should NOT await this — see
   * recordFireAndForget.
   */
  async record(userId: number, bookId: number, type: InteractionType): Promise<boolean> {
    if (isRedisDeduped(type)) {
      // SET NX EX — returns 'OK' only if the key did not already exist.
      const acquired = await redis.set(viewDedupeKey(userId, bookId), '1', 'EX', VIEW_DEDUPE_TTL, 'NX');
      if (acquired !== 'OK') return false;
    }

    const inserted = await db
      .insert(userInteractions)
      .values({ userId, bookId, type, weight: 1.0 })
      // Bare DO NOTHING covers the partial unique index without naming it. It only
      // swallows unique/exclusion violations — a bad book_id still raises the FK
      // error rather than being silently dropped.
      .onConflictDoNothing()
      .returning({ id: userInteractions.id });

    return inserted.length > 0;
  },

  /**
   * Fire-and-forget wrapper for hot paths like the book detail endpoint.
   *
   * Analytics must never add latency to, or fail, the request that triggered them:
   * a Redis blip while recording a view should not turn a working book page into a
   * 500. Errors are logged and swallowed.
   */
  recordFireAndForget(userId: number, bookId: number, type: InteractionType): void {
    void this.record(userId, bookId, type).catch((err: unknown) => {
      logger.error('Failed to record interaction', {
        userId,
        bookId,
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },

  /**
   * Deletes interaction rows older than `days`.
   *
   * View logging makes this the fastest-growing table in the database, and rows
   * past the trending window are dead weight for the only query that reads them.
   * Returns the number of rows removed.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const deleted = await db
      .delete(userInteractions)
      .where(lt(userInteractions.createdAt, cutoff))
      .returning({ id: userInteractions.id });

    return deleted.length;
  },
};

// ── Scoring SQL ───────────────────────────────────────────────────────────────

/**
 * Half-life, in days, of an interaction's contribution to the trending score.
 *
 * Without decay a book that spiked on day 1 sits in the list for the full 30-day
 * window at undiminished strength, which makes "trending" mean "was trending
 * sometime this month". A 7-day half-life means a signal is worth half as much a
 * week later and ~5% as much at the window's edge, so the list tracks what is
 * happening now while still being smooth enough not to thrash hour to hour.
 */
export const TRENDING_HALF_LIFE_DAYS = 7;

/**
 * Builds the trending score expression:
 *
 *   SUM(stored_weight × type_weight × 2^(-age_days / half_life))
 *
 * The stored `weight` column stays in the formula as a per-row multiplier (it
 * defaults to 1.0), so an individual row can still be boosted or damped without
 * inventing a new type. The type weight comes from INTERACTION_WEIGHTS above, and
 * unscored types collapse to 0 rather than silently counting as 1.
 */
export function trendingScoreSql() {
  const cases = TRENDING_SCORED_TYPES.map(
    (t) => sql`WHEN ${t} THEN ${INTERACTION_WEIGHTS[t]}::float`,
  );

  const typeWeight = sql`CASE ${userInteractions.type} ${sql.join(cases, sql` `)} ELSE 0 END`;

  const decay = sql`EXP(
    -LN(2)
    * (EXTRACT(EPOCH FROM (NOW() - ${userInteractions.createdAt})) / 86400.0)
    / ${TRENDING_HALF_LIFE_DAYS}::float
  )`;

  return sql<number>`SUM(${userInteractions.weight}::float * ${typeWeight} * ${decay})`;
}

/**
 * TypeScript mirror of the decay factor in the SQL above. Not used by the query —
 * it exists so the decay curve is unit-testable without a database, and so the
 * intended shape of the formula is pinned by a test if someone edits the SQL.
 */
export function decayFactor(ageDays: number, halfLifeDays: number = TRENDING_HALF_LIFE_DAYS): number {
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}
