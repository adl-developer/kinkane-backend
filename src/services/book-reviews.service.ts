import { and, eq, inArray, isNull, isNotNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { books, bookReviews, nielsenApiUsage, type ReviewSource } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { fetchReviewByIsbn, NielsenLimitExceededError } from '../lib/nielsen';

export interface BookReviewInfo {
  reviewHtml: string;
  /** Which service supplied the quote: 'nielsen' or 'bds'. */
  source: ReviewSource;
  sourceField: string | null;
}

/**
 * When more than one source has a review for a book, the first in this list
 * wins. Nielsen first: it was here first and its quotes were checked by hand
 * when the feature shipped. BDS fills the gaps. They are not merged — both
 * carry publisher-supplied quotes, so showing both would mostly repeat them.
 */
const SOURCE_PREFERENCE: readonly ReviewSource[] = ['nielsen', 'bds'];

export type BudgetKind = 'batch' | 'onDemand';

/**
 * Reserves one record of the daily Nielsen allowance, returning false when
 * that half of the budget is already spent.
 *
 * The claim happens before the request, not after, so that concurrent callers
 * cannot both see "999 used" and both spend the last record. A claim is never
 * refunded on failure: we cannot tell from an error whether Nielsen served
 * the record before we failed to read it, and overcounting costs us a lookup
 * while undercounting risks breaching the account limit.
 *
 * Exported for the integration suite: the guarantee that matters here is
 * atomicity under concurrency, and that can only be shown against a real
 * Postgres. See nielsen-budget.integration.test.ts.
 */
export async function claimBudget(kind: BudgetKind): Promise<boolean> {
  const limit = kind === 'batch' ? config.nielsen.dailyBatchBudget : config.nielsen.dailyOnDemandBudget;

  // Two literal statements rather than one with an interpolated column name —
  // the column is internal, but keeping it out of the SQL string keeps that
  // obvious to anyone reading it.
  const rows =
    kind === 'batch'
      ? await db.execute(sql`
          INSERT INTO nielsen_api_usage (day, batch_used, on_demand_used)
          VALUES (CURRENT_DATE, 1, 0)
          ON CONFLICT (day) DO UPDATE
            SET batch_used = nielsen_api_usage.batch_used + 1
            WHERE nielsen_api_usage.batch_used < ${limit}
              AND nielsen_api_usage.limit_hit_at IS NULL
          RETURNING batch_used
        `)
      : await db.execute(sql`
          INSERT INTO nielsen_api_usage (day, batch_used, on_demand_used)
          VALUES (CURRENT_DATE, 0, 1)
          ON CONFLICT (day) DO UPDATE
            SET on_demand_used = nielsen_api_usage.on_demand_used + 1
            WHERE nielsen_api_usage.on_demand_used < ${limit}
              AND nielsen_api_usage.limit_hit_at IS NULL
          RETURNING on_demand_used
        `);

  return (rows as unknown as unknown[]).length > 0;
}

/**
 * Records that Nielsen itself said the allowance is gone. Their count is
 * authoritative over ours, and this stops both halves of the budget for the
 * rest of the day.
 */
async function markLimitHit(): Promise<void> {
  await db.execute(sql`
    INSERT INTO nielsen_api_usage (day, limit_hit_at)
    VALUES (CURRENT_DATE, now())
    ON CONFLICT (day) DO UPDATE SET limit_hit_at = now()
  `);
  logger.warn('Nielsen daily limit reached — pausing lookups until tomorrow');
}

/**
 * Writes the outcome of a lookup, including a miss, so we stop re-asking.
 * Exported for the BDS enrichment service, which records its reviews here too.
 */
export async function storeReviewResults(
  source: ReviewSource,
  results: { isbn13: string; reviewHtml: string | null; sourceField: string | null }[],
): Promise<void> {
  if (results.length === 0) return;
  const checkedAt = new Date();
  await db
    .insert(bookReviews)
    .values(results.map((r) => ({ ...r, source, checkedAt })))
    .onConflictDoUpdate({
      target: [bookReviews.isbn13, bookReviews.source],
      set: {
        reviewHtml: sql`excluded.review_html`,
        sourceField: sql`excluded.source_field`,
        checkedAt: sql`excluded.checked_at`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Looks one ISBN up and stores whatever came back. Returns null when no
 * lookup happened at all (no budget, or the limit has been hit), which the
 * batch job uses as its signal to stop early.
 */
async function lookupAndStore(isbn13: string, kind: BudgetKind): Promise<boolean | null> {
  if (!(await claimBudget(kind))) return null;

  try {
    const result = await fetchReviewByIsbn(isbn13);
    await storeReviewResults('nielsen', [
      { isbn13, reviewHtml: result?.reviewHtml ?? null, sourceField: result?.sourceField ?? null },
    ]);
    return result !== null;
  } catch (err) {
    if (err instanceof NielsenLimitExceededError) {
      await markLimitHit();
      return null;
    }
    throw err;
  }
}

/**
 * Batch-looks-up stored reviews for a set of ISBNs. Filters out nulls so
 * callers can pass `isbn13` columns directly, and omits misses — a row with
 * no review text is bookkeeping, not something to hand to the client. Where
 * several sources have one, SOURCE_PREFERENCE picks.
 */
export async function getReviewsByIsbns(
  isbns: (string | null)[],
): Promise<Map<string, BookReviewInfo>> {
  const map = new Map<string, BookReviewInfo>();

  const uniqueIsbns = [...new Set(isbns.filter((isbn): isbn is string => isbn !== null))];
  if (uniqueIsbns.length === 0) return map;

  const rows = await db
    .select({
      isbn13: bookReviews.isbn13,
      source: bookReviews.source,
      reviewHtml: bookReviews.reviewHtml,
      sourceField: bookReviews.sourceField,
    })
    .from(bookReviews)
    .where(and(inArray(bookReviews.isbn13, uniqueIsbns), isNotNull(bookReviews.reviewHtml)));

  const rank = (s: ReviewSource) => {
    const i = SOURCE_PREFERENCE.indexOf(s);
    return i === -1 ? SOURCE_PREFERENCE.length : i;
  };
  for (const row of rows) {
    if (!row.reviewHtml) continue;
    const current = map.get(row.isbn13);
    if (current && rank(current.source) <= rank(row.source)) continue;
    map.set(row.isbn13, { reviewHtml: row.reviewHtml, source: row.source, sourceField: row.sourceField });
  }

  return map;
}

/** Looks up the review for a single ISBN, or null if there isn't one. */
export function pickReview(
  isbn13: string | null,
  reviewMap: Map<string, BookReviewInfo>,
): BookReviewInfo | null {
  if (!isbn13) return null;
  return reviewMap.get(isbn13) ?? null;
}

export const bookReviewsService = {
  /**
   * Fetches a review for a book nobody has asked Nielsen about yet, then drops
   * the cached book detail so the next request serves it.
   *
   * Deliberately fire-and-forget: a book page must never wait on Nielsen, so
   * the first visitor to an unchecked book still sees the page without a
   * review and the one after them gets it. Callers should not await this.
   */
  async fetchOnDemand(isbn13: string | null, bookId: number): Promise<void> {
    if (!config.nielsen.enabled || !isbn13) return;

    try {
      const [existing] = await db
        .select({ id: bookReviews.id })
        .from(bookReviews)
        .where(and(eq(bookReviews.isbn13, isbn13), eq(bookReviews.source, 'nielsen')))
        .limit(1);

      // Already asked — whether we got a review or not, don't ask again here.
      // Stale misses are re-checked by the batch job, not by visitor traffic.
      if (existing) return;

      const found = await lookupAndStore(isbn13, 'onDemand');
      if (found) {
        await redis.del(`book:detail:${bookId}`);
        logger.info('Nielsen on-demand review stored', { isbn13, bookId });
      }
    } catch (err) {
      // On-demand is best-effort decoration on a page that has already been
      // served — it must never surface as a request failure.
      logger.error('Nielsen on-demand review lookup failed', {
        isbn13,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * The nightly sweep. Spends up to NIELSEN_DAILY_BATCH_BUDGET records,
   * leaving the rest of the account's allowance for visitor lookups.
   *
   * At 900/day against a catalogue of roughly two million this will never be
   * a full sweep — it is a priority queue, working newest-first through
   * active titles, on the reasoning that those are what the app actually
   * surfaces. Everything else only ever gets a review via fetchOnDemand.
   */
  async runDailyBatch(): Promise<{ checked: number; found: number; stoppedEarly: boolean }> {
    if (!config.nielsen.enabled) {
      logger.warn('Nielsen reviews disabled (NIELSEN_REVIEWS_ENABLED is not "true") — skipping batch');
      return { checked: 0, found: 0, stoppedEarly: false };
    }

    const recheckCutoff = new Date(Date.now() - config.nielsen.missRecheckDays * 24 * 60 * 60 * 1000);

    const candidates = await db
      .select({ isbn13: books.isbn13 })
      .from(books)
      .leftJoin(bookReviews, and(eq(bookReviews.isbn13, books.isbn13), eq(bookReviews.source, 'nielsen')))
      .where(
        and(
          isNotNull(books.isbn13),
          eq(books.publishingStatus, '04'),
          or(
            isNull(bookReviews.id),
            // A miss is worth re-asking eventually: reviews are often filed
            // weeks after publication, so an empty answer in week one is not
            // an empty answer forever.
            and(isNull(bookReviews.reviewHtml), lt(bookReviews.checkedAt, recheckCutoff)),
          ),
        ),
      )
      .orderBy(sql`${books.publicationDate} DESC NULLS LAST`)
      .limit(config.nielsen.dailyBatchBudget);

    if (candidates.length === 0) {
      logger.info('Nielsen review batch: nothing to check');
      return { checked: 0, found: 0, stoppedEarly: false };
    }

    logger.info('Nielsen review batch: starting', { candidates: candidates.length });

    let checked = 0;
    let found = 0;
    let errors = 0;
    let stoppedEarly = false;

    for (const candidate of candidates) {
      if (!candidate.isbn13) continue;

      let outcome: boolean | null;
      try {
        outcome = await lookupAndStore(candidate.isbn13, 'batch');
      } catch (err) {
        errors++;
        logger.error('Nielsen review lookup failed', {
          isbn13: candidate.isbn13,
          error: err instanceof Error ? err.message : String(err),
        });
        // The record is spent either way, so move on rather than retrying it
        // into the same failure.
        continue;
      }

      if (outcome === null) {
        stoppedEarly = true;
        break;
      }

      checked++;
      if (outcome) found++;

      if (config.nielsen.requestDelayMs > 0) {
        await new Promise((res) => setTimeout(res, config.nielsen.requestDelayMs));
      }
    }

    logger.info('Nielsen review batch: complete', { checked, found, errors, stoppedEarly });
    return { checked, found, stoppedEarly };
  },
};
