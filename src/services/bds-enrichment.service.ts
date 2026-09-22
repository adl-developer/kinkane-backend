import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { books, bookAuthorBios } from '../db/schema';
import { config } from '../config';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';
import { BdsAuthError, fetchByIsbns, fetchUpdatedPage, type BdsRecord } from '../lib/bds';
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
  opts: { delayMs?: number } = {},
): Promise<{ checked: number; bios: number; reviews: number }> {
  const unique = [...new Set(isbns.filter(Boolean))];
  const totals = { checked: 0, bios: 0, reviews: 0 };

  for (let i = 0; i < unique.length; i += config.bds.batchSize) {
    if (i > 0 && opts.delayMs) await sleep(opts.delayMs);
    const batch = unique.slice(i, i + config.bds.batchSize);
    const results = await fetchByIsbns(batch);
    const stored = await storeResults(results);
    totals.checked += batch.length;
    totals.bios += stored.bios;
    totals.reviews += stored.reviews;
  }
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
   * The nightly sweep: books BDS have never been asked about, then misses old
   * enough to be worth asking again, newest publications first.
   *
   * `limit` overrides BDS_NIGHTLY_ISBN_LIMIT — the backfill script passes a
   * large one to work through the whole catalogue in one go.
   */
  async runSweep(opts: { limit?: number } = {}): Promise<{ checked: number; bios: number; reviews: number }> {
    const limit = opts.limit ?? config.bds.nightlyIsbnLimit;
    const totals = { checked: 0, bios: 0, reviews: 0 };
    if (limit <= 0) return totals;

    const recheckCutoff = new Date(Date.now() - config.bds.missRecheckDays * 24 * 60 * 60 * 1000);

    // Selected in pages so a catalogue-sized backfill never holds a million
    // ISBNs in memory, and so progress is committed as it goes.
    const pageSize = 5_000;
    while (totals.checked < limit) {
      const candidates = await db
        .select({ isbn13: books.isbn13 })
        .from(books)
        .leftJoin(bookAuthorBios, eq(bookAuthorBios.isbn13, books.isbn13))
        .where(
          and(
            isNotNull(books.isbn13),
            eq(books.publishingStatus, '04'),
            or(
              isNull(bookAuthorBios.id),
              and(isNull(bookAuthorBios.bioHtml), lt(bookAuthorBios.checkedAt, recheckCutoff)),
            ),
          ),
        )
        .orderBy(sql`${books.publicationDate} DESC NULLS LAST`)
        .limit(Math.min(pageSize, limit - totals.checked));

      // Each stored answer bumps checked_at past the cutoff or creates the
      // row, so the same query naturally moves on to the next books.
      const isbns = candidates.map((c) => c.isbn13).filter((i): i is string => i !== null);
      if (isbns.length === 0) break;

      const done = await enrichIsbns(isbns, { delayMs: config.bds.requestDelayMs });
      totals.checked += done.checked;
      totals.bios += done.bios;
      totals.reviews += done.reviews;
      logger.info('BDS sweep progress', totals);
    }
    return totals;
  },

  /**
   * Picks up changes BDS made yesterday or today to books we have already
   * looked up — a publisher adding a bio or a new review quote.
   *
   * This pages through every record BDS changed, not just ours, keeping only
   * ISBNs we sell. It is capped at BDS_DELTA_MAX_PAGES and says so when it
   * hits the cap; if BDS's daily change volume turns out to be large, their
   * filtered daily feed is the better tool.
   */
  async runDailyDelta(now = new Date()): Promise<{ pages: number; stored: number; truncated: boolean }> {
    const maxPages = config.bds.deltaMaxPages;
    const result = { pages: 0, stored: 0, truncated: false };
    if (maxPages <= 0) return result;

    const from = ymd(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const to = ymd(now);

    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && config.bds.requestDelayMs) await sleep(config.bds.requestDelayMs);
      const { records, rawCount } = await fetchUpdatedPage(from, to, page);
      result.pages++;

      if (records.length > 0) {
        // Only books we have already asked about: new ones are the sweep's job,
        // and this keeps the delta from creating rows for books we don't sell.
        const known = await db
          .select({ isbn13: bookAuthorBios.isbn13, sourceUpdated: bookAuthorBios.sourceUpdated })
          .from(bookAuthorBios)
          .where(inArray(bookAuthorBios.isbn13, [...new Set(records.map((r) => r.isbn13))]));
        const version = new Map(known.map((k) => [k.isbn13, k.sourceUpdated]));

        const changed = new Map<string, BdsRecord | null>();
        for (const record of records) {
          if (!version.has(record.isbn13)) continue;
          if (record.indexUpdated && version.get(record.isbn13) === record.indexUpdated) continue;
          if (!changed.has(record.isbn13)) changed.set(record.isbn13, record);
        }
        await storeResults(changed);
        result.stored += changed.size;
      }

      if (rawCount < 100) return result;
    }

    result.truncated = true;
    logger.warn('BDS daily delta hit its page cap — some changes were not applied', {
      maxPages,
      from,
      to,
    });
    return result;
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
      const delta = await this.runDailyDelta();
      logger.info('BDS daily delta complete', delta);
      const sweep = await this.runSweep();
      logger.info('BDS sweep complete', sweep);
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
