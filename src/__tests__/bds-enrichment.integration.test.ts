import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { BdsRecord } from '../lib/bds';

/**
 * BDS enrichment against a real Postgres: what lands in book_author_bios and
 * book_reviews, how it coexists with Nielsen's rows, and which books the
 * sweep and the daily delta pick.
 *
 * The BDS HTTP client is replaced with an in-memory fake (the client itself is
 * covered by bds-client.test.ts); everything from the service down to the
 * SQL is real. Same safety rules as nielsen-budget.integration.test.ts:
 * TEST_DATABASE_URL only, never the database `.env` names.
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
  process.env.BDS_ENRICHMENT_ENABLED = 'true';
  process.env.BDS_USERNAME = 'test';
  process.env.BDS_PASSWORD = 'test';
  process.env.BDS_REQUEST_DELAY_MS = '0';
  process.env.BDS_BATCH_SIZE = '2';
}

// ── Fakes ────────────────────────────────────────────────────────────────────

/** What the fake BDS holds, by ISBN. Absent = BDS has no record. */
const bdsData = new Map<string, Partial<BdsRecord>>();
const bdsCalls: string[][] = [];
let updatedPages: Partial<BdsRecord>[][] = [];

function record(isbn13: string, fields: Partial<BdsRecord> = {}): BdsRecord {
  return {
    isbn13,
    authorBio: null,
    biographicalNotes: [],
    review: null,
    prizes: null,
    relatedEditions: [],
    indexUpdated: null,
    ...fields,
  };
}

vi.mock('../lib/bds', async () => {
  const actual = await vi.importActual<typeof import('../lib/bds')>('../lib/bds');
  return {
    ...actual,
    fetchByIsbns: async (isbns: string[]) => {
      bdsCalls.push(isbns);
      return new Map(isbns.map((i) => [i, bdsData.has(i) ? record(i, bdsData.get(i)) : null]));
    },
    fetchUpdatedPage: async (_from: string, _to: string, page: number) => {
      const recs = (updatedPages[page] ?? []).map((r) => record(r.isbn13!, r));
      return { records: recs, rawCount: recs.length };
    },
  };
});

const redisStore = new Map<string, string>();
vi.mock('../lib/redis', () => ({
  redis: {
    get: async (k: string) => redisStore.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    },
    del: async (k: string) => (redisStore.delete(k) ? 1 : 0),
  },
}));

// ── Setup ────────────────────────────────────────────────────────────────────

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let svc: typeof import('../services/bds-enrichment.service');
let reviews: typeof import('../services/book-reviews.service');

const PREFIX = 'BDSTEST-';
const describeIfDb = testUrl ? describe : describe.skip;

async function addBook(isbn13: string, publicationDate: string, status = '04') {
  await db.execute(sql`
    INSERT INTO books (record_reference, isbn13, title, publishing_status, publication_date)
    VALUES (${PREFIX + isbn13}, ${isbn13}, ${'Test ' + isbn13}, ${status}, ${publicationDate})
  `);
}

async function bioRow(isbn13: string) {
  const rows = (await db.execute(
    sql`SELECT bio_html, source_field, source_updated, checked_at FROM book_author_bios WHERE isbn13 = ${isbn13}`,
  )) as unknown as { bio_html: string | null; source_field: string | null; source_updated: string | null; checked_at: Date }[];
  return rows[0];
}

async function reviewRows(isbn13: string) {
  return (await db.execute(
    sql`SELECT source, review_html FROM book_reviews WHERE isbn13 = ${isbn13} ORDER BY source`,
  )) as unknown as { source: string; review_html: string | null }[];
}

describeIfDb('BDS enrichment', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    svc = await import('../services/bds-enrichment.service');
    reviews = await import('../services/book-reviews.service');

    const [present] = (await db.execute(sql`SELECT to_regclass('public.book_author_bios') AS t`)) as unknown as {
      t: string | null;
    }[];
    if (!present?.t) {
      throw new Error('book_author_bios does not exist in TEST_DATABASE_URL. Run `npm run db:migrate` against it.');
    }
  });

  async function clean() {
    await db.execute(sql`TRUNCATE book_author_bios, book_reviews`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${PREFIX + '%'}`);
  }

  beforeEach(async () => {
    await clean();
    bdsData.clear();
    bdsCalls.length = 0;
    updatedPages = [];
    redisStore.clear();
  });

  afterAll(async () => {
    if (testUrl) await clean();
  });

  it('stores bio and review hits, and misses for both, in one pass', async () => {
    bdsData.set('9780000000001', { authorBio: '<p>Bio one</p>', review: '<p>Great * Observer *</p>', indexUpdated: '20260920' });
    bdsData.set('9780000000002', { biographicalNotes: ['<p>Note A</p>', '<p>Note B</p>'] });

    const totals = await svc.enrichIsbns(['9780000000001', '9780000000002', '9780000000003']);

    expect(totals).toEqual({ checked: 3, bios: 2, reviews: 1 });
    expect(await bioRow('9780000000001')).toMatchObject({ bio_html: '<p>Bio one</p>', source_field: 'author_bio', source_updated: '20260920' });
    expect(await bioRow('9780000000002')).toMatchObject({ bio_html: '<p>Note A</p>\n<p>Note B</p>', source_field: 'biographical_note' });
    // BDS had no record: a miss is still written, so the sweep moves on.
    expect(await bioRow('9780000000003')).toMatchObject({ bio_html: null });
    expect(await reviewRows('9780000000001')).toEqual([{ source: 'bds', review_html: '<p>Great * Observer *</p>' }]);
    expect(await reviewRows('9780000000003')).toEqual([{ source: 'bds', review_html: null }]);
  });

  it('batches by BDS_BATCH_SIZE and survives a duplicated ISBN', async () => {
    await svc.enrichIsbns(['9780000000001', '9780000000002', '9780000000001', '9780000000003']);
    expect(bdsCalls).toEqual([['9780000000001', '9780000000002'], ['9780000000003']]);
  });

  it('keeps Nielsen and BDS rows side by side, and prefers Nielsen when both have one', async () => {
    await reviews.storeReviewResults('nielsen', [
      { isbn13: '9780000000001', reviewHtml: '<p>Nielsen quote</p>', sourceField: 'NBDFREV' },
      { isbn13: '9780000000002', reviewHtml: null, sourceField: null },
    ]);
    bdsData.set('9780000000001', { review: '<p>BDS quote one</p>' });
    bdsData.set('9780000000002', { review: '<p>BDS quote two</p>' });

    await svc.enrichIsbns(['9780000000001', '9780000000002']);

    // Neither source overwrote the other's row.
    expect((await reviewRows('9780000000001')).map((r) => r.source)).toEqual(['bds', 'nielsen']);
    const map = await reviews.getReviewsByIsbns(['9780000000001', '9780000000002']);
    expect(map.get('9780000000001')).toMatchObject({ source: 'nielsen', reviewHtml: '<p>Nielsen quote</p>' });
    // Nielsen had nothing for this one: BDS fills the gap.
    expect(map.get('9780000000002')).toMatchObject({ source: 'bds', reviewHtml: '<p>BDS quote two</p>' });
  });

  it('getBiosByIsbns leaves out misses', async () => {
    bdsData.set('9780000000001', { authorBio: '<p>Bio</p>' });
    await svc.enrichIsbns(['9780000000001', '9780000000002']);

    const bios = await svc.getBiosByIsbns(['9780000000001', '9780000000002', null]);
    expect([...bios.keys()]).toEqual(['9780000000001']);
  });

  it('sweep: active books never asked, newest first, then stops', async () => {
    await addBook('9780000000010', '2020-01-01');
    await addBook('9780000000011', '2026-01-01');
    await addBook('9780000000012', '2024-01-01');
    await addBook('9780000000013', '2026-06-01', '07'); // out of print — skipped
    await db.execute(sql`INSERT INTO book_author_bios (isbn13, bio_html) VALUES ('9780000000012', '<p>have it</p>')`);

    const first = await svc.bdsEnrichmentService.runSweep({ limit: 1 });
    expect(first.checked).toBe(1);
    expect(bdsCalls.flat()).toEqual(['9780000000011']);

    const rest = await svc.bdsEnrichmentService.runSweep({ limit: 100 });
    expect(rest.checked).toBe(1);
    expect(bdsCalls.flat()).toEqual(['9780000000011', '9780000000010']);

    // Nothing left to ask about.
    expect((await svc.bdsEnrichmentService.runSweep({ limit: 100 })).checked).toBe(0);
  });

  it('sweep: re-asks about a miss only once it is older than the recheck window', async () => {
    await addBook('9780000000020', '2026-01-01');
    await addBook('9780000000021', '2026-01-01');
    await db.execute(sql`
      INSERT INTO book_author_bios (isbn13, bio_html, checked_at) VALUES
        ('9780000000020', NULL, now() - interval '400 days'),
        ('9780000000021', NULL, now() - interval '1 day')
    `);

    await svc.bdsEnrichmentService.runSweep({ limit: 100 });
    expect(bdsCalls.flat()).toEqual(['9780000000020']);
  });

  it('delta: updates books we already know when their version changed, ignores the rest', async () => {
    await db.execute(sql`
      INSERT INTO book_author_bios (isbn13, bio_html, source_updated) VALUES
        ('9780000000030', '<p>old</p>', '20260101'),
        ('9780000000031', '<p>same</p>', '20260921')
    `);
    updatedPages = [[
      { isbn13: '9780000000030', authorBio: '<p>new</p>', review: '<p>new quote</p>', indexUpdated: '20260921' },
      { isbn13: '9780000000031', authorBio: '<p>changed?</p>', indexUpdated: '20260921' },
      { isbn13: '9780000000099', authorBio: '<p>not ours</p>', indexUpdated: '20260921' },
    ]];

    const result = await svc.bdsEnrichmentService.runDailyDelta(new Date('2026-09-22T03:00:00Z'));

    expect(result).toEqual({ pages: 1, stored: 1, truncated: false });
    expect((await bioRow('9780000000030')).bio_html).toBe('<p>new</p>');
    expect((await bioRow('9780000000031')).bio_html).toBe('<p>same</p>');
    expect(await bioRow('9780000000099')).toBeUndefined();
    expect(await reviewRows('9780000000030')).toEqual([{ source: 'bds', review_html: '<p>new quote</p>' }]);
  });

  it('delta: flags a run that hit the page cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ isbn13: `97800000${String(i).padStart(5, '0')}` }));
    updatedPages = Array.from({ length: 200 }, () => full);

    const result = await svc.bdsEnrichmentService.runDailyDelta();
    expect(result.truncated).toBe(true);
    expect(result.pages).toBe(100);
  });

  it('on-demand: looks up an unseen book once, then never again', async () => {
    bdsData.set('9780000000040', { authorBio: '<p>Bio</p>' });
    redisStore.set('book:detail:40', '{"cached":true}');

    await svc.bdsEnrichmentService.fetchOnDemand('9780000000040', 40);
    await svc.bdsEnrichmentService.fetchOnDemand('9780000000040', 40);

    expect(bdsCalls).toEqual([['9780000000040']]);
    // The cached page is dropped so the next visitor sees the bio.
    expect(redisStore.has('book:detail:40')).toBe(false);
  });

  it('nightly: a second worker does nothing while the first holds the lock', async () => {
    await addBook('9780000000050', '2026-01-01');
    redisStore.set('bds:nightly-lock', 'other-pid');

    await svc.bdsEnrichmentService.runNightly();
    expect(bdsCalls).toEqual([]);
  });
});
