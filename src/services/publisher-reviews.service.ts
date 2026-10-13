import { and, eq, inArray, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { db } from '../db';
import { bookReviews } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { extractReviewItems } from '../lib/gemini';
import { extractPublisherReviews, type ExtractionMethod } from '../lib/publisher-reviews';
import { storeReviewResults } from './book-reviews.service';

/**
 * Keeps the 'publisher' rows of book_reviews in step with the books' long
 * descriptions.
 *
 * Only books with reviews get a row: a book whose description has none has no
 * row at all, and a row is deleted when a changed description no longer has
 * any. Each row carries the md5 of the text it was read from, so a book with
 * reviews is skipped until its description changes. Books without a row have
 * no such record, so a pass re-checks them; the rules are cheap (75k
 * descriptions in about 9 seconds), and each page is committed before the
 * next is read, so a pass is safe to stop and resume.
 *
 * Two entry points share that pass. The backfill walks the whole catalogue by
 * id; the nightly run only looks at books the ingester has touched since the
 * last successful run (books.updated_at, which the ONIX upsert sets).
 */

const NIGHTLY_LOCK_KEY = 'publisher-reviews:nightly-lock';
const NIGHTLY_LOCK_TTL_SECONDS = 6 * 60 * 60;
const WATERMARK_KEY = 'publisher-reviews:watermark';
/** Re-read a little before the last run started, for writes that committed during it. */
const WATERMARK_OVERLAP_MS = 10 * 60 * 1000;
/** With no watermark yet, the nightly run looks back this far; the backfill covers the rest. */
const DEFAULT_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

// A type alias rather than an interface: db.execute<T> needs T to be a Record.
type Candidate = {
  id: number;
  isbn13: string;
  long_description: string | null;
  hash: string;
  old_html: string | null;
};

export interface PassStats {
  scanned: number;
  /** Rows written: books that have reviews. */
  stored: number;
  /** Rows deleted: books whose changed description no longer has reviews. */
  removed: number;
  changed: number;
  byMethod: Record<ExtractionMethod, number>;
  llmCalls: number;
  /** The last book id a backfill finished; pass it as afterId to resume. */
  lastId: number;
}

function emptyStats(): PassStats {
  return {
    scanned: 0,
    stored: 0,
    removed: 0,
    changed: 0,
    byMethod: { rules: 0, llm: 0, rules_fallback: 0 },
    llmCalls: 0,
    lastId: 0,
  };
}

/**
 * Which books are due. A book without a row is due if it has a long
 * description to read. A book with a row is due when its description no
 * longer hashes the same, including when the description has been removed.
 *
 * `force` makes every book with a row due as well, for when the extraction
 * rules change: an unchanged description would otherwise keep its old result.
 */
function dueCondition(opts: { retryFallback?: boolean; force?: boolean } = {}) {
  return sql`(
    (r.id IS NULL AND NOT b.is_removed AND btrim(coalesce(b.long_description, '')) <> '')
    OR (r.id IS NOT NULL AND r.source_hash IS DISTINCT FROM md5(coalesce(b.long_description, '')))
    ${opts.retryFallback ? sql`OR r.source_field = 'rules_fallback'` : sql``}
    ${opts.force ? sql`OR r.id IS NOT NULL` : sql``}
  )`;
}

async function extractAndStore(rows: Candidate[], stats: PassStats, useLlm: boolean): Promise<void> {
  const limit = pLimit(config.publisherReviews.llmConcurrency);
  const llm = useLlm
    ? (text: string) => {
        stats.llmCalls++;
        return extractReviewItems(text);
      }
    : undefined;

  const results = await Promise.all(
    rows.map((row) => limit(async () => ({ row, result: await extractPublisherReviews(row.long_description, llm) }))),
  );

  const found = results.filter(({ result }) => result.reviewHtml);
  await storeReviewResults(
    'publisher',
    found.map(({ row, result }) => ({
      isbn13: row.isbn13,
      reviewHtml: result.reviewHtml,
      sourceField: result.method,
      sourceHash: row.hash,
    })),
  );

  // No reviews any more: the row goes, rather than staying as an empty one.
  const gone = results.filter(({ row, result }) => !result.reviewHtml && row.old_html !== null).map(({ row }) => row.isbn13);
  if (gone.length > 0) {
    await db.delete(bookReviews).where(and(eq(bookReviews.source, 'publisher'), inArray(bookReviews.isbn13, gone)));
  }

  // A book page caches its review for an hour; drop the ones that changed so
  // the new review (or its removal) shows on the next view.
  const changedIds = results.filter(({ row, result }) => row.old_html !== result.reviewHtml).map(({ row }) => row.id);
  for (let i = 0; i < changedIds.length; i += 500) {
    await redis.del(...changedIds.slice(i, i + 500).map((id) => `book:detail:${id}`)).catch(() => undefined);
  }

  stats.scanned += rows.length;
  stats.stored += found.length;
  stats.removed += gone.length;
  stats.changed += changedIds.length;
  for (const { result } of results) stats.byMethod[result.method]++;
}

export const publisherReviewsService = {
  /**
   * Walks the whole catalogue by id. Used once to fill the table; again with
   * `retryFallback` to send books the rules handed over to the LLM after a run
   * where it was unavailable; and with `force` to redo every book after the
   * extraction rules change.
   */
  async runBackfill(
    opts: {
      limit?: number;
      retryFallback?: boolean;
      force?: boolean;
      useLlm?: boolean;
      /** Resume after this book id (a stopped run's lastId). */
      afterId?: number;
      onPage?: (stats: PassStats) => void;
    } = {},
  ): Promise<PassStats> {
    const stats = emptyStats();
    const useLlm = opts.useLlm ?? config.publisherReviews.llmEnabled;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    let afterId = opts.afterId ?? 0;

    while (stats.scanned < limit) {
      const page = await db.execute<Candidate & { last_id: number }>(sql`
        WITH page AS (
          SELECT id FROM books WHERE id > ${afterId} AND isbn13 IS NOT NULL ORDER BY id LIMIT ${PAGE_SIZE}
        )
        SELECT b.id, b.isbn13, b.long_description, md5(coalesce(b.long_description, '')) AS hash,
               r.review_html AS old_html, (SELECT max(id) FROM page) AS last_id
        FROM page
        JOIN books b ON b.id = page.id
        LEFT JOIN book_reviews r ON r.isbn13 = b.isbn13 AND r.source = 'publisher'
        WHERE ${dueCondition(opts)}
        ORDER BY b.id
      `);
      const rows = page as unknown as (Candidate & { last_id: number })[];

      if (rows.length > 0) {
        await extractAndStore(rows.slice(0, Math.max(0, limit - stats.scanned)), stats, useLlm);
        afterId = rows[0].last_id;
      } else {
        // Nothing due on this page: move past it without reading descriptions again.
        const next = await db.execute<{ last_id: number | null }>(sql`
          SELECT max(id) AS last_id FROM (
            SELECT id FROM books WHERE id > ${afterId} AND isbn13 IS NOT NULL ORDER BY id LIMIT ${PAGE_SIZE}
          ) p
        `);
        const lastId = (next as unknown as { last_id: number | null }[])[0]?.last_id;
        if (lastId === null || lastId === undefined) break;
        afterId = lastId;
      }
      stats.lastId = afterId;
      opts.onPage?.({ ...stats, byMethod: { ...stats.byMethod } });
    }

    return stats;
  },

  /**
   * Re-extracts books whose description changed since the last run. The
   * watermark only moves forward after a run completes, so a failed night is
   * picked up by the next one.
   */
  async runChanged(since: Date): Promise<PassStats> {
    const stats = emptyStats();
    const useLlm = config.publisherReviews.llmEnabled;
    let cursor: { updatedAt: string; id: number } | null = null;

    for (;;) {
      const page = await db.execute<Candidate & { updated_at: string }>(sql`
        SELECT b.id, b.isbn13, b.long_description, md5(coalesce(b.long_description, '')) AS hash,
               r.review_html AS old_html, b.updated_at
        FROM books b
        LEFT JOIN book_reviews r ON r.isbn13 = b.isbn13 AND r.source = 'publisher'
        WHERE b.isbn13 IS NOT NULL
          AND b.updated_at >= ${since.toISOString()}
          ${cursor ? sql`AND (b.updated_at, b.id) > (${cursor.updatedAt}::timestamptz, ${cursor.id})` : sql``}
          AND ${dueCondition()}
        ORDER BY b.updated_at, b.id
        LIMIT ${PAGE_SIZE}
      `);
      const rows = page as unknown as (Candidate & { updated_at: string })[];
      if (rows.length === 0) break;
      await extractAndStore(rows, stats, useLlm);
      const last = rows[rows.length - 1];
      cursor = { updatedAt: new Date(last.updated_at).toISOString(), id: last.id };
      if (rows.length < PAGE_SIZE) break;
    }

    return stats;
  },

  /** What the cron runs. One worker does the work; the rest see the lock and skip. */
  async runNightly(): Promise<void> {
    if (!config.publisherReviews.enabled) {
      logger.warn('Publisher reviews disabled (PUBLISHER_REVIEWS_ENABLED is not "true") — skipping nightly run');
      return;
    }

    const locked = await redis.set(NIGHTLY_LOCK_KEY, String(process.pid), 'EX', NIGHTLY_LOCK_TTL_SECONDS, 'NX');
    if (locked !== 'OK') {
      logger.info('Publisher reviews nightly run already in progress elsewhere — skipping');
      return;
    }

    try {
      const startedAt = Date.now();
      const stored = await redis.get(WATERMARK_KEY);
      const since = stored ? new Date(stored) : new Date(startedAt - DEFAULT_LOOKBACK_MS);
      const stats = await this.runChanged(since);
      await redis.set(WATERMARK_KEY, new Date(startedAt - WATERMARK_OVERLAP_MS).toISOString());
      logger.info('Publisher reviews nightly run complete', { since: since.toISOString(), ...stats, ms: Date.now() - startedAt });
    } finally {
      await redis.del(NIGHTLY_LOCK_KEY).catch(() => undefined);
    }
  },
};
