import { and, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { books, bookAuthorBios } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import pLimit from 'p-limit';
import { BdsAuthError, fetchByIsbns, type BdsRecord } from '../lib/bds';
import { rebuildAuthorBios } from './author-bios.service';
import { storeReviewResults } from './book-reviews.service';

/**
 * Author bios and review quotes from BDS (Bibliographic Data Services).
 *
 * One BDS lookup answers both questions, so one pass stores both: the bio in
 * book_author_bios and the review in book_reviews under source 'bds'. Both are
 * written on a miss too, as "asked, nothing".
 *
 * Unlike Nielsen there is no metered quota to ration — BDS answer 100 ISBNs a
 * call — so there is no budget table. The limits here are politeness and run
 * length, and a Redis lock so a multi-process deploy runs each job once.
 */

export interface AuthorBioInfo {
  bioHtml: string;
  sourceField: string | null;
}

const NIGHTLY_LOCK_KEY = 'bds:nightly-lock';
const NIGHTLY_LOCK_TTL_SECONDS = 6 * 60 * 60;
const ON_DEMAND_LOCK_TTL_SECONDS = 60;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * The bio to show for a record: `author_bio` when BDS have it, otherwise the
 * ONIX biographical note(s). Several notes (one per contributor) are kept in
 * order as one block.
 */
export function pickBio(record: BdsRecord): { bioHtml: string; sourceField: string } | null {
  if (record.authorBio) return { bioHtml: record.authorBio, sourceField: 'author_bio' };
  const notes = [...new Set(record.biographicalNotes)];
  if (notes.length > 0) return { bioHtml: notes.join('\n'), sourceField: 'biographical_note' };
  return null;
}

/**
 * Writes one batch of answers. `results` has an entry for every ISBN asked
 * about; null means BDS returned no record, which is stored as a miss.
 */
async function storeResults(results: Map<string, BdsRecord | null>): Promise<{ bios: number; reviews: number }> {
  if (results.size === 0) return { bios: 0, reviews: 0 };
  const checkedAt = new Date();

  const bioRows = [...results].map(([isbn13, record]) => {
    const bio = record ? pickBio(record) : null;
    return {
      isbn13,
      bioHtml: bio?.bioHtml ?? null,
      sourceField: bio?.sourceField ?? null,
      sourceUpdated: record?.indexUpdated ?? null,
      checkedAt,
    };
  });

  await db
    .insert(bookAuthorBios)
    .values(bioRows)
    .onConflictDoUpdate({
      target: bookAuthorBios.isbn13,
      set: {
        bioHtml: sql`excluded.bio_html`,
        sourceField: sql`excluded.source_field`,
        sourceUpdated: sql`excluded.source_updated`,
        checkedAt: sql`excluded.checked_at`,
        updatedAt: sql`now()`,
      },
    });

  const reviewRows = [...results].map(([isbn13, record]) => ({
    isbn13,
    reviewHtml: record?.review ?? null,
    sourceField: record?.review ? 'review' : null,
  }));
  await storeReviewResults('bds', reviewRows);

  return {
    bios: bioRows.filter((r) => r.bioHtml).length,
    reviews: reviewRows.filter((r) => r.reviewHtml).length,
  };
}

/**
 * Looks up any number of ISBNs, a batch per call, and stores the answers.
 * Deduplicates first: two copies of one ISBN in a single upsert would fail
 * the whole batch with "cannot affect row a second time".
 */
export async function enrichIsbns(
  isbns: string[],
  opts: { delayMs?: number; concurrency?: number } = {},
): Promise<{ checked: number; bios: number; reviews: number; failed: number }> {
  const unique = [...new Set(isbns.filter(Boolean))];
  const totals = { checked: 0, bios: 0, reviews: 0, failed: 0 };

  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += config.bds.batchSize) {
    batches.push(unique.slice(i, i + config.bds.batchSize));
  }

  // BDS publish no rate limit and none showed up in testing (30 calls at six
  // at a time, no failures, no slowdown), but "none observed" is not "none",
  // so concurrency defaults to 1 and is raised deliberately. At 4-6 a full
  // catalogue pass drops from about 8 hours to 2.5.
  const concurrency = Math.max(1, opts.concurrency ?? config.bds.concurrency);
  const limit = pLimit(concurrency);

  await Promise.all(
    batches.map((batch, index) =>
      limit(async () => {
        // Running one at a time, the delay is the pacing. Running several, the
        // concurrency limit is the pacing and the delay would simply idle
        // every worker — so it is used once, to stagger the opening burst.
        if (opts.delayMs) {
          if (concurrency === 1) {
            if (index > 0) await sleep(opts.delayMs);
          } else if (index < concurrency) {
            await sleep(Math.round((opts.delayMs / concurrency) * index));
          }
        }
        try {
          const results = await fetchByIsbns(batch);
          const stored = await storeResults(results);
          totals.checked += batch.length;
          totals.bios += stored.bios;
          totals.reviews += stored.reviews;
        } catch (err) {
          // Credentials will not fix themselves, so that one stops the run.
          if (err instanceof BdsAuthError) throw err;
          // Anything else costs this batch and nothing more. A backfill is
          // ~11,000 requests over hours; ending all of it because one failed
          // (after its own retries) would throw away everything already done,
          // and the books are simply picked up by the next run.
          totals.failed += batch.length;
          logger.warn('BDS batch failed, skipping', {
            isbns: batch.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    ),
  );
  return totals;
}

/** Stored bios for a set of ISBNs. Misses are left out, as with reviews. */
export async function getBiosByIsbns(isbns: (string | null)[]): Promise<Map<string, AuthorBioInfo>> {
  const map = new Map<string, AuthorBioInfo>();
  const unique = [...new Set(isbns.filter((i): i is string => i !== null))];
  if (unique.length === 0) return map;

  const rows = await db
    .select({ isbn13: bookAuthorBios.isbn13, bioHtml: bookAuthorBios.bioHtml, sourceField: bookAuthorBios.sourceField })
    .from(bookAuthorBios)
    .where(and(inArray(bookAuthorBios.isbn13, unique), isNotNull(bookAuthorBios.bioHtml)));

  for (const row of rows) {
    if (row.bioHtml) map.set(row.isbn13, { bioHtml: row.bioHtml, sourceField: row.sourceField });
  }
  return map;
}

/** yyyymmdd for a Date, in UTC. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export const bdsEnrichmentService = {
  /**
   * Looks up a book nobody has asked BDS about yet, then drops the cached
   * book detail so the next request shows what was found.
   *
   * Fire-and-forget, like Nielsen's on-demand path: the page never waits on
   * BDS. A short Redis lock stops a burst of visitors to one new book from
   * each triggering the same call.
   */
  async fetchOnDemand(isbn13: string | null, bookId: number): Promise<void> {
    if (!config.bds.enabled || !isbn13) return;

    try {
      const [existing] = await db
        .select({ id: bookAuthorBios.id })
        .from(bookAuthorBios)
        .where(eq(bookAuthorBios.isbn13, isbn13))
        .limit(1);
      if (existing) return;

      const locked = await redis.set(`bds:ondemand:${isbn13}`, '1', 'EX', ON_DEMAND_LOCK_TTL_SECONDS, 'NX');
      if (locked !== 'OK') return;

      const { bios, reviews } = await enrichIsbns([isbn13]);
      if (bios > 0 || reviews > 0) {
        await redis.del(`book:detail:${bookId}`);
        logger.info('BDS on-demand enrichment stored', { isbn13, bookId, bios, reviews });
      }
    } catch (err) {
      // Decoration on a page already served — never a request failure.
      logger.error('BDS on-demand enrichment failed', {
        isbn13,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * The nightly pass, and the backfill: books BDS has never been asked about
   * first, then the oldest answers, so the catalogue refreshes on a rotation.
   *
   * Two tiers rather than one query, because they want different orders:
   *
   *  1. **Never asked** — new books from the Gardners ingest, and everything
   *     the backfill has not reached yet. Walked by `books.id` as a keyset:
   *     an `ORDER BY publication_date` over a million rows is a sequential
   *     scan plus a sort, repeated for every page, and it gets slower as the
   *     ledger fills.
   *  2. **Asked longest ago** — the refresh rotation, oldest `checked_at`
   *     first. BDS change ~136,000 records a day and their API will only
   *     page through 5,000 results, so asking them what changed is not
   *     possible; re-asking about our own books on a cycle is. At the default
   *     30 days that is ~1/30th of the catalogue a night.
   *
   * `limit` caps how many ISBNs one run may spend.
   */
  async runSweep(opts: { limit?: number; concurrency?: number } = {}): Promise<{
    checked: number;
    bios: number;
    reviews: number;
    failed: number;
    fresh: number;
    refreshed: number;
  }> {
    const limit = opts.limit ?? config.bds.nightlyIsbnLimit;
    const totals = { checked: 0, bios: 0, reviews: 0, failed: 0, fresh: 0, refreshed: 0 };
    if (limit <= 0) return totals;

    const pageSize = 5_000;
    const run = async (isbns: string[]) => {
      const done = await enrichIsbns(isbns, {
        delayMs: config.bds.requestDelayMs,
        concurrency: opts.concurrency,
      });
      totals.checked += done.checked;
      totals.bios += done.bios;
      totals.reviews += done.reviews;
      totals.failed += done.failed;
      // Failed batches count as progress for the keyset: they are not retried
      // in this run, or a persistent failure would loop forever.
      return done.checked + done.failed;
    };

    // Tier 1: never asked, walked by id.
    let afterId = 0;
    while (totals.checked < limit) {
      const rows = await db
        .select({ id: books.id, isbn13: books.isbn13 })
        .from(books)
        .leftJoin(bookAuthorBios, eq(bookAuthorBios.isbn13, books.isbn13))
        .where(
          and(
            isNotNull(books.isbn13),
            eq(books.publishingStatus, '04'),
            gt(books.id, afterId),
            isNull(bookAuthorBios.id),
          ),
        )
        .orderBy(books.id)
        .limit(Math.min(pageSize, limit - totals.checked));

      if (rows.length === 0) break;
      afterId = rows[rows.length - 1].id;
      totals.fresh += await run(rows.map((r) => r.isbn13!).filter(Boolean));
      logger.info('BDS sweep progress (new books)', totals);
    }

    // Tier 2: the refresh rotation, and re-checks of books BDS had nothing for.
    const refreshCutoff = new Date(Date.now() - config.bds.refreshDays * 24 * 60 * 60 * 1000);
    while (totals.checked < limit) {
      const rows = await db
        .select({ isbn13: bookAuthorBios.isbn13 })
        .from(bookAuthorBios)
        .innerJoin(books, eq(books.isbn13, bookAuthorBios.isbn13))
        .where(and(eq(books.publishingStatus, '04'), lt(bookAuthorBios.checkedAt, refreshCutoff)))
        .orderBy(bookAuthorBios.checkedAt)
        .limit(Math.min(pageSize, limit - totals.checked));

      if (rows.length === 0) break;
      totals.refreshed += await run(rows.map((r) => r.isbn13));
      logger.info('BDS sweep progress (refresh)', totals);
    }

    return totals;
  },

  /** What the cron runs: yesterday's changes, then the sweep. */
  async runNightly(): Promise<void> {
    if (!config.bds.enabled) {
      logger.warn('BDS enrichment disabled (BDS_ENRICHMENT_ENABLED is not "true" or credentials missing) — skipping');
      return;
    }

    // In cluster mode every worker's cron fires; only one should do the work.
    const locked = await redis.set(NIGHTLY_LOCK_KEY, String(process.pid), 'EX', NIGHTLY_LOCK_TTL_SECONDS, 'NX');
    if (locked !== 'OK') {
      logger.info('BDS nightly run already in progress elsewhere — skipping');
      return;
    }

    try {
      const sweep = await this.runSweep();
      logger.info('BDS sweep complete', sweep);
      // Author pages are derived from what the sweep just stored, so they are
      // rebuilt in the same run rather than drifting a day behind.
      const authors = await rebuildAuthorBios();
      logger.info('BDS author biographies rebuilt', authors);
    } catch (err) {
      if (err instanceof BdsAuthError) {
        logger.error('BDS credentials rejected — nightly run stopped', { error: err.message });
        return;
      }
      throw err;
    } finally {
      await redis.del(NIGHTLY_LOCK_KEY).catch(() => undefined);
    }
  },
};
