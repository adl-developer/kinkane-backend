import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { db } from '../db';
import { bookReviews } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { extractReviewItems } from '../lib/gemini';
import { extractPublisherReviews, type ExtractionMethod } from '../lib/publisher-reviews';
import { toCleanDescription } from '../lib/review-text';
import { storeReviewResults } from './book-reviews.service';

/**
 * Keeps the 'publisher' rows of book_reviews in step with the books' long
 * descriptions.
 *
 * Only books with reviews get a row: a book whose description has none has no
 * row at all, and a row is deleted when a changed description no longer has
 * any. Each row carries a hash of the text it was read from (descriptionHash),
 * so a book with reviews is skipped until its description changes. Books without a row have
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

// Type aliases rather than interfaces: db.execute<T> needs T to be a Record.
/** A book as read for a pass, with its current publisher row if it has one. */
type BookRow = {
  id: number;
  isbn13: string;
  long_description: string | null;
  is_removed: boolean;
  has_row: boolean;
  old_html: string | null;
  old_hash: string | null;
  old_field: string | null;
};
type Candidate = BookRow & { hash: string };

/**
 * md5 of the description as a reader sees it, after toCleanDescription. Taken
 * from the cleaned text rather than the stored one so that removing HTML from
 * the stored descriptions (scripts/clean-long-descriptions.ts) does not make
 * every book look changed: cleaning is idempotent, so the hash is the same
 * before and after.
 */
export function descriptionHash(longDescription: string | null): string {
  return createHash('md5').update(toCleanDescription(longDescription ?? '')).digest('hex');
}

/**
 * Which books are due. A book without a row is due if it has a long
 * description with text in it. A book with a row is due when its description
 * no longer hashes the same, including when the description has been removed.
 *
 * `force` makes every book with a row due as well, for when the extraction
 * rules change: an unchanged description would otherwise keep its old result.
 */
function dueRows(rows: BookRow[], opts: { retryFallback?: boolean; force?: boolean } = {}): Candidate[] {
  const due: Candidate[] = [];
  for (const row of rows) {
    const hash = descriptionHash(row.long_description);
    const isDue = row.has_row
      ? row.old_hash !== hash || !!opts.force || (!!opts.retryFallback && row.old_field === 'rules_fallback')
      : !row.is_removed && toCleanDescription(row.long_description ?? '') !== '';
    if (isDue) due.push({ ...row, hash });
  }
  return due;
}

/** The columns every pass reads: the book, and its publisher row if any. */
const PASS_COLUMNS = sql`
  b.id, b.isbn13, b.long_description, b.is_removed,
  (r.id IS NOT NULL) AS has_row, r.review_html AS old_html, r.source_hash AS old_hash, r.source_field AS old_field
`;

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

  const found = results.filter(({ result }) => result.reviewText);
  await storeReviewResults(
    'publisher',
    found.map(({ row, result }) => ({
      isbn13: row.isbn13,
      // The column is review_html for the supplier sources; publisher reviews
      // are stored as plain text (see toReviewText).
      reviewHtml: result.reviewText,
      sourceField: result.method,
      sourceHash: row.hash,
    })),
  );

  // No reviews any more: the row goes, rather than staying as an empty one.
  const gone = results.filter(({ row, result }) => !result.reviewText && row.old_html !== null).map(({ row }) => row.isbn13);
  if (gone.length > 0) {
    await db.delete(bookReviews).where(and(eq(bookReviews.source, 'publisher'), inArray(bookReviews.isbn13, gone)));
  }

  // A book page caches its review for an hour; drop the ones that changed so
  // the new review (or its removal) shows on the next view.
  const changedIds = results.filter(({ row, result }) => row.old_html !== result.reviewText).map(({ row }) => row.id);
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
      // Books with a description, or a row to remove now that it has none.
      const page = await db.execute<BookRow>(sql`
        SELECT ${PASS_COLUMNS}
        FROM books b
        LEFT JOIN book_reviews r ON r.isbn13 = b.isbn13 AND r.source = 'publisher'
        WHERE b.id > ${afterId} AND b.isbn13 IS NOT NULL
          AND (btrim(coalesce(b.long_description, '')) <> '' OR r.id IS NOT NULL)
        ORDER BY b.id
        LIMIT ${PAGE_SIZE}
      `);
      const rows = page as unknown as BookRow[];
      if (rows.length === 0) break;

      const due = dueRows(rows, opts);
      const room = limit - stats.scanned;
      const batch = due.slice(0, room);
      await extractAndStore(batch, stats, useLlm);
      // Resume point: the end of the page, unless --limit cut the page short.
      afterId = due.length > room ? batch[batch.length - 1].id : rows[rows.length - 1].id;
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
      const page = await db.execute<BookRow & { updated_at: string }>(sql`
        SELECT ${PASS_COLUMNS}, b.updated_at
        FROM books b
        LEFT JOIN book_reviews r ON r.isbn13 = b.isbn13 AND r.source = 'publisher'
        WHERE b.isbn13 IS NOT NULL
          AND b.updated_at >= ${since.toISOString()}
          ${cursor ? sql`AND (b.updated_at, b.id) > (${cursor.updatedAt}::timestamptz, ${cursor.id})` : sql``}
          AND (btrim(coalesce(b.long_description, '')) <> '' OR r.id IS NOT NULL)
        ORDER BY b.updated_at, b.id
        LIMIT ${PAGE_SIZE}
      `);
      const rows = page as unknown as (BookRow & { updated_at: string })[];
      if (rows.length === 0) break;
      await extractAndStore(dueRows(rows), stats, useLlm);
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
