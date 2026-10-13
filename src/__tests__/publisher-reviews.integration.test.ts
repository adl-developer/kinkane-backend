import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { ReviewItem } from '../lib/publisher-reviews';

/**
 * Publisher reviews against a real Postgres: which books a pass picks, what
 * lands in book_reviews, how it ranks against Nielsen and BDS, and how a
 * changed description is picked up.
 *
 * Gemini and Redis are faked; the extraction rules and everything from the
 * service down to the SQL are real. Same safety rules as the other
 * integration suites: TEST_DATABASE_URL only, never the database `.env` names.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  const configured = configuredUrl();
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(`TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}).`);
  }
  process.env.DATABASE_URL = testUrl;
  process.env.PUBLISHER_REVIEWS_ENABLED = 'true';
  process.env.PUBLISHER_REVIEWS_LLM_ENABLED = 'true';
}

// ── Fakes ────────────────────────────────────────────────────────────────────

/** What the fake model answers; null = the call failed. */
let llmAnswer: ReviewItem[] | null = [];
const llmCalls: string[] = [];
vi.mock('../lib/gemini', () => ({
  extractReviewItems: async (text: string) => {
    llmCalls.push(text);
    return llmAnswer;
  },
}));

const redisStore = new Map<string, string>();
const deletedKeys: string[] = [];
vi.mock('../lib/redis', () => ({
  redis: {
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      deletedKeys.push(...keys);
      return keys.filter((k) => redisStore.delete(k)).length;
    },
  },
}));

// ── Setup ────────────────────────────────────────────────────────────────────

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let svc: typeof import('../services/publisher-reviews.service').publisherReviewsService;
let descriptionHash: typeof import('../services/publisher-reviews.service').descriptionHash;
let reviews: typeof import('../services/book-reviews.service');

const PREFIX = 'PUBREVTEST-';
const describeIfDb = testUrl ? describe : describe.skip;

const CLEAN = "<p>'Delightful' Veronica Henry</p><p>From the moment Lily arrives on the island…</p>";
const MESSY = "Get HOOKED on this thriller!'I couldn't take my eyes off it' Janice Hallett'Addictive and brilliant' Lisa Jewell";
const PLAIN = '<p>A quiet story about a family farm.</p>';

async function addBook(isbn13: string, longDescription: string | null): Promise<number> {
  const [row] = (await db.execute(sql`
    INSERT INTO books (record_reference, isbn13, title, long_description)
    VALUES (${PREFIX + isbn13}, ${isbn13}, ${'Test ' + isbn13}, ${longDescription})
    RETURNING id
  `)) as unknown as { id: number }[];
  return row.id;
}

async function publisherRow(isbn13: string) {
  const rows = (await db.execute(sql`
    SELECT r.review_html, r.source_field, r.source_hash, b.long_description
    FROM book_reviews r JOIN books b ON b.isbn13 = r.isbn13
    WHERE r.isbn13 = ${isbn13} AND r.source = 'publisher'
  `)) as unknown as { review_html: string | null; source_field: string; source_hash: string; long_description: string | null }[];
  const row = rows[0];
  if (!row) return undefined;
  return {
    review_html: row.review_html,
    source_field: row.source_field,
    hash_matches: row.source_hash === descriptionHash(row.long_description),
  };
}

describeIfDb('publisher reviews', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ publisherReviewsService: svc, descriptionHash } = await import('../services/publisher-reviews.service'));
    reviews = await import('../services/book-reviews.service');
  });

  async function clean() {
    await db.execute(sql`TRUNCATE book_reviews`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${PREFIX + '%'}`);
  }

  beforeEach(async () => {
    await clean();
    llmAnswer = [];
    llmCalls.length = 0;
    redisStore.clear();
    deletedKeys.length = 0;
  });

  afterAll(async () => {
    if (testUrl) await clean();
  });

  it('backfill stores a row only for books whose description has reviews', async () => {
    await addBook('9780000000001', CLEAN);
    await addBook('9780000000002', PLAIN);
    await addBook('9780000000003', null);

    const stats = await svc.runBackfill();

    expect(stats).toMatchObject({ scanned: 2, stored: 1, removed: 0 });
    expect(await publisherRow('9780000000001')).toEqual({
      review_html: '“Delightful”\n— Veronica Henry',
      source_field: 'rules',
      hash_matches: true,
    });
    expect(await publisherRow('9780000000002')).toBeUndefined();
    expect(await publisherRow('9780000000003')).toBeUndefined();
    const [{ empty }] = (await db.execute(
      sql`SELECT count(*)::int AS empty FROM book_reviews WHERE source = 'publisher' AND review_html IS NULL`,
    )) as unknown as { empty: number }[];
    expect(empty).toBe(0);
    expect(llmCalls).toEqual([]);
  });

  it('a second backfill skips books it already has reviews for, and re-checks the rest', async () => {
    await addBook('9780000000001', CLEAN);
    await addBook('9780000000002', PLAIN);
    await svc.runBackfill();
    expect(await svc.runBackfill()).toMatchObject({ scanned: 1, stored: 0 });
  });

  it('removing HTML from a stored description does not make its book due again', async () => {
    const id = await addBook('9780000000001', CLEAN);
    await svc.runBackfill();
    const { toCleanDescription } = await import('../lib/review-text');
    await db.execute(sql`UPDATE books SET long_description = ${toCleanDescription(CLEAN)}, updated_at = now() WHERE id = ${id}`);

    expect(await svc.runBackfill()).toMatchObject({ scanned: 0 });
    expect(await svc.runChanged(new Date(Date.now() - 60_000))).toMatchObject({ scanned: 0 });
    expect(await publisherRow('9780000000001')).toMatchObject({ hash_matches: true });
  });

  it('a --limit run reports a resume point that skips nothing', async () => {
    const ids = [];
    for (let i = 1; i <= 3; i++) ids.push(await addBook(`978000000000${i}`, CLEAN));
    const first = await svc.runBackfill({ limit: 2 });
    expect(first).toMatchObject({ scanned: 2, lastId: ids[1] });
    expect(await svc.runBackfill({ afterId: first.lastId })).toMatchObject({ scanned: 1, stored: 1 });
  });

  it('resumes after a given book id', async () => {
    const first = await addBook('9780000000001', CLEAN);
    await addBook('9780000000002', CLEAN);
    const stats = await svc.runBackfill({ afterId: first });
    expect(stats).toMatchObject({ scanned: 1, stored: 1 });
    expect(await publisherRow('9780000000001')).toBeUndefined();
    expect(stats.lastId).toBeGreaterThan(first);
  });

  it('--force redoes every book, for when the rules change', async () => {
    await addBook('9780000000001', CLEAN);
    await addBook('9780000000002', PLAIN);
    await svc.runBackfill();
    expect(await svc.runBackfill({ force: true })).toMatchObject({ scanned: 2, changed: 0 });
  });

  it('only sends what the rules could not split to the LLM, and keeps only what validates', async () => {
    await addBook('9780000000001', MESSY);
    llmAnswer = [
      { kind: 'author', quote: "I couldn't take my eyes off it", attribution: 'Janice Hallett' },
      { kind: 'critic', quote: 'A masterpiece', attribution: 'The Times' },
    ];

    const stats = await svc.runBackfill();

    expect(llmCalls).toHaveLength(1);
    expect(stats.byMethod).toEqual({ rules: 0, llm: 1, rules_fallback: 0 });
    expect(await publisherRow('9780000000001')).toMatchObject({
      review_html: "“I couldn't take my eyes off it”\n— Janice Hallett",
      source_field: 'llm',
    });
  });

  it('marks books for a retry when the LLM is down, and --retry-fallback picks them up', async () => {
    await addBook('9780000000001', MESSY);
    llmAnswer = null;
    await svc.runBackfill();
    expect(await publisherRow('9780000000001')).toMatchObject({ source_field: 'rules_fallback' });

    // An ordinary re-run leaves it alone: the description has not changed.
    expect(await svc.runBackfill()).toMatchObject({ scanned: 0 });

    llmAnswer = [{ kind: 'author', quote: 'Addictive and brilliant', attribution: 'Lisa Jewell' }];
    await svc.runBackfill({ retryFallback: true });
    expect(await publisherRow('9780000000001')).toMatchObject({ source_field: 'llm' });
  });

  it('ranks below Nielsen and BDS, and fills the gap when they have nothing', async () => {
    await addBook('9780000000001', CLEAN);
    await addBook('9780000000002', CLEAN);
    await addBook('9780000000003', CLEAN);
    await svc.runBackfill();
    await reviews.storeReviewResults('nielsen', [{ isbn13: '9780000000001', reviewHtml: '<p>Nielsen</p>', sourceField: 'NBDFREV' }]);
    await reviews.storeReviewResults('bds', [
      { isbn13: '9780000000002', reviewHtml: '<p>BDS</p>', sourceField: 'review' },
      { isbn13: '9780000000003', reviewHtml: null, sourceField: null },
    ]);

    const map = await reviews.getReviewsByIsbns(['9780000000001', '9780000000002', '9780000000003']);

    expect(map.get('9780000000001')?.source).toBe('nielsen');
    expect(map.get('9780000000002')?.source).toBe('bds');
    expect(map.get('9780000000003')).toMatchObject({ source: 'publisher', sourceField: 'rules' });
  });

  it('a nightly pass re-extracts a changed description, deletes the row of a removed one, and drops their cached pages', async () => {
    const changedId = await addBook('9780000000001', PLAIN);
    const clearedId = await addBook('9780000000002', CLEAN);
    await svc.runBackfill();
    deletedKeys.length = 0;

    await db.execute(sql`UPDATE books SET long_description = ${CLEAN}, updated_at = now() WHERE id = ${changedId}`);
    await db.execute(sql`UPDATE books SET long_description = NULL, updated_at = now() WHERE id = ${clearedId}`);
    const stats = await svc.runChanged(new Date(Date.now() - 60_000));

    expect(stats).toMatchObject({ scanned: 2, stored: 1, removed: 1, changed: 2 });
    expect(await publisherRow('9780000000001')).toMatchObject({ review_html: '“Delightful”\n— Veronica Henry', hash_matches: true });
    expect(await publisherRow('9780000000002')).toBeUndefined();
    expect(deletedKeys.sort()).toEqual([`book:detail:${changedId}`, `book:detail:${clearedId}`].sort());
  });

  it('a nightly pass ignores books changed before the watermark', async () => {
    const id = await addBook('9780000000001', CLEAN);
    await db.execute(sql`UPDATE books SET updated_at = now() - interval '3 days' WHERE id = ${id}`);
    expect(await svc.runChanged(new Date(Date.now() - 60_000))).toMatchObject({ scanned: 0 });
  });

  it('nightly: a second worker does nothing while the first holds the lock, and a finished run moves the watermark', async () => {
    await addBook('9780000000001', CLEAN);
    redisStore.set('publisher-reviews:nightly-lock', 'other');
    await svc.runNightly();
    expect(await publisherRow('9780000000001')).toBeUndefined();

    redisStore.clear();
    await svc.runNightly();
    expect(await publisherRow('9780000000001')).toMatchObject({ source_field: 'rules' });
    expect(redisStore.get('publisher-reviews:watermark')).toBeDefined();
    expect(redisStore.has('publisher-reviews:nightly-lock')).toBe(false);
  });
});
