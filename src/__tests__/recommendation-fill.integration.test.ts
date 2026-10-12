import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * The quiz list fills to its target even when the preference vector has almost
 * nothing near it, against a real Postgres with pgvector.
 *
 * WHY THIS EXISTS. The list is cut in memory out of one nearest-first vector
 * search, topped up from further pages, then from a genre fallback. Whether that
 * really reaches the target — with the HNSW settings, the edition collapsing and
 * the exclusions all applied — is a property of the queries running together,
 * which only a real database shows.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite inserts and
 * deletes books. Skips itself when unset; refuses to run when it names the same
 * database as `.env`. Setup as in nielsen-budget.integration.test.ts.
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
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'These tests delete rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

// A small pool, so a test catalogue of a hundred-odd books can fill it and
// reach the wide second pass. Set before the service is imported, which is
// when config reads it; dotenv never overrides a variable already set.
process.env.RECO_FETCH_POOL = '50';

vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));

const describeIfDb = testUrl ? describe : describe.skip;
const REF = 'reco-fill-test-';
const GENRE_SLUG = 'reco-fill-test-crime';
// Stock rows are keyed on ISBN, not book, so cleanup finds them by this prefix.
const ISBN_PREFIX = '979099999';
const EMAIL = 'reco-fill-test-reader@example.com';
const DIMS = 768;

/** A unit vector along one axis, nudged slightly towards another. */
function axis(i: number, nudge?: { towards: number; by: number }): string {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  if (nudge) v[nudge.towards] = nudge.by;
  return `[${v.join(',')}]`;
}

type Spec = {
  key: string;
  title: string;
  author: string;
  embedding: string | null;
  inStock?: boolean;
  crime?: boolean;
  published?: string;
  stockQty?: number;
};

describeIfDb('recommendation list fill', () => {
  let db: typeof import('../db').db;
  let sql: typeof import('drizzle-orm').sql;
  let svc: typeof import('../services/recommendations.service');
  let feed: typeof import('../services/books.service');
  let exclusions: typeof import('../lib/exclusions');
  const ids = new Map<string, number>();

  async function insertBook(spec: Spec, n: number, genreId: number) {
    const isbn = `${ISBN_PREFIX}${String(n).padStart(4, '0')}`;
    const [row] = (await db.execute(sql`
      INSERT INTO books (record_reference, title, isbn13, publication_date, embedding)
      VALUES (${REF + spec.key}, ${spec.title}, ${isbn}, ${spec.published ?? '2020-01-01'},
              ${spec.embedding}::vector)
      RETURNING id
    `)) as unknown as { id: number }[];
    ids.set(spec.key, row.id);
    await db.execute(sql`
      INSERT INTO book_contributors (book_id, sequence_number, role, person_name)
      VALUES (${row.id}, 1, 'A01', ${spec.author})
    `);
    await db.execute(sql`
      INSERT INTO gardners_stock (isbn13, book_id, rrp_gbp, stock_qty, source, stock_updated_at)
      VALUES (${isbn}, ${row.id}, 9.99, ${spec.inStock === false ? 0 : (spec.stockQty ?? 5)}, 'inventory', now())
    `);
    if (spec.crime) {
      await db.execute(sql`INSERT INTO book_genres (book_id, genre_id) VALUES (${row.id}, ${genreId})`);
    }
  }

  async function cleanUp() {
    await db.execute(sql`DELETE FROM gardners_stock WHERE isbn13 LIKE ${ISBN_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${REF + '%'}`);
    await db.execute(sql`DELETE FROM genres WHERE slug = ${GENRE_SLUG}`);
    // Cascades to the reader's interactions.
    await db.execute(sql`DELETE FROM users WHERE email = ${EMAIL}`);
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    svc = await import('../services/recommendations.service');
    feed = await import('../services/books.service');
    exclusions = await import('../lib/exclusions');

    await cleanUp();
    const [genre] = (await db.execute(sql`
      INSERT INTO genres (name, slug, subject_code) VALUES ('Crime (test)', ${GENRE_SLUG}, 'FFZZ') RETURNING id
    `)) as unknown as { id: number }[];

    const specs: Spec[] = [
      // Strict: three works right on the query vector, one of them in two editions.
      { key: 'strict-a', title: 'Strict A', author: 'Ama Owusu', embedding: axis(0, { towards: 1, by: 0.01 }) },
      { key: 'strict-b', title: 'Strict B', author: 'Kofi Mensah', embedding: axis(0, { towards: 1, by: 0.02 }) },
      { key: 'strict-c1', title: 'Strict C', author: 'Esi Boateng', embedding: axis(0, { towards: 1, by: 0.03 }) },
      { key: 'strict-c2', title: 'Strict C', author: 'Esi Boateng', embedding: axis(0, { towards: 1, by: 0.04 }) },
      // Near the vector but excluded — must never appear.
      { key: 'out-of-stock', title: 'Gone', author: 'Yaw Darko', embedding: axis(0), inStock: false },
      { key: 'rejected', title: 'Rejected', author: 'Abena Asante', embedding: axis(0, { towards: 1, by: 0.05 }) },
      // Reach: orthogonal to the query (distance 1.0), past the backfill cutoff.
      ...Array.from({ length: 20 }, (_, i) => ({
        key: `reach-${i}`,
        title: `Reach ${i}`,
        author: `Reach Author ${i}`,
        embedding: axis(2 + i),
      })),
      // No embedding at all: only the genre fallback can reach these. The
      // untagged ones are newer, so ranking them after the tagged ones shows the
      // genre narrowing came first.
      ...Array.from({ length: 40 }, (_, i) => ({
        key: `genre-${i}`,
        title: `Genre ${i}`,
        author: `Genre Author ${i}`,
        embedding: null,
        crime: true,
        published: `2019-01-${String((i % 28) + 1).padStart(2, '0')}`,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        key: `untagged-${i}`,
        title: `Untagged ${i}`,
        author: `Untagged Author ${i}`,
        embedding: null,
        published: '2025-06-01',
      })),
    ];

    // For the wide-pass test: five works in twelve editions each, nearest of
    // all, then fifty single-edition works just behind them — every one of them
    // well inside the strict cutoff. The first 50-row pool is all editions of
    // the five works.
    const editionSpecs: Spec[] = [
      ...Array.from({ length: 60 }, (_, i) => ({
        key: `ed-multi-${i}`,
        title: `Many Editions ${i % 5}`,
        author: `Prolific Author ${i % 5}`,
        embedding: axis(0, { towards: 1, by: 0.001 * (i + 1) }),
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        key: `ed-single-${i}`,
        title: `Single Edition ${i}`,
        author: `Single Author ${i}`,
        embedding: axis(0, { towards: 1, by: 0.1 + 0.002 * i }),
      })),
    ];

    // For the fallback-batches test: no embeddings, so only the genre fallback
    // can reach them. The newest 200 are editions of just four works — enough
    // to fill a whole first batch (needed x 4 = 200) — with 60 distinct works
    // published earlier behind them.
    const fallbackSpecs: Spec[] = [
      ...Array.from({ length: 200 }, (_, i) => ({
        key: `fb-multi-${i}`,
        title: `Reissued ${i % 4}`,
        author: `Reissue Author ${i % 4}`,
        embedding: null,
        crime: true,
        published: '2024-06-01',
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        key: `fb-single-${i}`,
        title: `Backlist ${i}`,
        author: `Backlist Author ${i}`,
        embedding: null,
        crime: true,
        published: '2010-01-01',
      })),
    ];

    // For the filler tests: books outside every match, to pad with. One has
    // reader activity, one has deep stock, and two must never be used — one
    // rejected by the reader, one out of stock.
    const fillerSpecs: Spec[] = [
      { key: 'fl-trending', title: 'Everyone Is Reading', author: 'Popular Author', embedding: null },
      { key: 'fl-deep', title: 'Piled High', author: 'Stocked Author', embedding: null, stockQty: 900 },
      { key: 'fl-rejected', title: 'Swiped Away', author: 'Rejected Author', embedding: null, stockQty: 1000 },
      { key: 'fl-oos', title: 'Sold Out', author: 'Gone Author', embedding: null, inStock: false },
      ...Array.from({ length: 60 }, (_, i) => ({
        key: `fl-plain-${i}`,
        title: `Plain ${i}`,
        author: `Plain Author ${i}`,
        embedding: null,
      })),
    ];

    let n = 0;
    for (const spec of [...specs, ...editionSpecs, ...fallbackSpecs, ...fillerSpecs]) {
      await insertBook(spec, (n += 1), genre.id);
    }

    const [reader] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified) VALUES ('Fill Test Reader', ${EMAIL}, true) RETURNING id
    `)) as unknown as { id: number }[];
    await db.execute(sql`
      INSERT INTO user_interactions (user_id, book_id, type, weight)
      VALUES (${reader.id}, ${ids.get('fl-trending')!}, 'want_to_read', 1)
    `);
  });

  afterAll(async () => {
    await cleanUp();
  });

  it('fills to the target in tier order without breaking any exclusion', async () => {
    const { notInArray } = await import('drizzle-orm');
    const { books } = await import('../db/schema');
    const baseConditions = [
      feed.buildFeedCondition(),
      exclusions.buildHasAuthorCondition(),
      notInArray(books.id, [ids.get('rejected')!]),
      // Confine the search to this test's books, whatever else the scratch
      // database holds.
      sql`${books.recordReference} LIKE ${REF + '%'}`,
      sql`${books.recordReference} NOT LIKE ${REF + 'ed-%'}`,
      sql`${books.recordReference} NOT LIKE ${REF + 'fb-%'}`,
      sql`${books.recordReference} NOT LIKE ${REF + 'fl-%'}`,
    ];

    const rows = await svc.fetchCandidateBooks(axis(0), baseConditions, ['crime'], baseConditions);
    const keyById = new Map([...ids].map(([k, v]) => [v, k]));
    const keys = rows.map((r) => keyById.get(r.id)!);

    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.id)).size).toBe(50);

    expect(keys).not.toContain('out-of-stock');
    expect(keys).not.toContain('rejected');
    // Two editions of one work become one card.
    expect(keys.filter((k) => k.startsWith('strict-c'))).toHaveLength(1);

    // Tier order: 3 strict works, then all 20 reach books, then 27 from the
    // genre fallback — every one of them crime-tagged, ahead of newer untagged books.
    expect(keys.slice(0, 3).every((k) => k.startsWith('strict-'))).toBe(true);
    expect(keys.slice(3, 23).every((k) => k.startsWith('reach-'))).toBe(true);
    expect(keys.slice(23).every((k) => k.startsWith('genre-'))).toBe(true);
  });

  it('reads a wider pool when a full one collapses into too few works', async () => {
    const { books } = await import('../db/schema');
    const rows = await svc.fetchCandidateBooks(
      axis(0),
      [feed.buildFeedCondition(), sql`${books.recordReference} LIKE ${REF + 'ed-%'}`],
      ['crime'],
      [feed.buildFeedCondition(), sql`${books.recordReference} LIKE ${REF + 'ed-%'}`],
    );
    const keyById = new Map([...ids].map(([k, v]) => [v, k]));
    const keys = rows.map((r) => keyById.get(r.id)!);

    // The 50-row pool holds only five works. The wide pass finds the rest as
    // strict matches, so the list is the five multi-edition works once each and
    // then the single editions in distance order. The genre fallback could reach
    // the same books (it needs no embedding), but newest-first, not by distance —
    // the exact order is what proves the wide pass did the filling.
    expect(rows).toHaveLength(50);
    expect(keys.every((k) => k.startsWith('ed-'))).toBe(true);
    expect(new Set(rows.slice(0, 5).map((r) => r.title))).toEqual(
      new Set(Array.from({ length: 5 }, (_, i) => `Many Editions ${i}`)),
    );
    expect(rows.slice(5).map((r) => r.title)).toEqual(
      Array.from({ length: 45 }, (_, i) => `Single Edition ${i}`),
    );
  });

  it('keeps reading fallback batches when one collapses into too few works', async () => {
    const { books } = await import('../db/schema');
    const rows = await svc.fetchCandidateBooks(
      axis(0),
      [feed.buildFeedCondition(), sql`${books.recordReference} LIKE ${REF + 'fb-%'}`],
      // An unmapped genre, so there is one fallback pass, not a narrowed one
      // followed by an open one — the open pass would rescue a single-batch
      // fallback and hide exactly the failure this test is for.
      ['a genre with no mapping'],
      [feed.buildFeedCondition(), sql`${books.recordReference} LIKE ${REF + 'fb-%'}`],
    );

    // The first batch is 200 editions of four works. Stopping there would
    // return four books; reading on reaches the backlist.
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r.title.startsWith('Reissued'))).toHaveLength(4);
    expect(rows.filter((r) => r.title.startsWith('Backlist'))).toHaveLength(46);
  });

  it('pads with popular in-stock books when the matches run out', async () => {
    const { notInArray } = await import('drizzle-orm');
    const { books } = await import('../db/schema');
    // Only three works match; the filler may use any of the fl- books, minus
    // the one this reader rejected. Its rules are deliberately looser than the
    // matches' — no genre, format or dislike here — which is the point.
    const rows = await svc.fetchCandidateBooks(
      axis(0),
      [feed.buildFeedCondition(), sql`${books.recordReference} LIKE ${REF + 'strict-%'}`],
      ['crime'],
      [
        feed.buildFeedCondition(),
        exclusions.buildHasAuthorCondition(),
        notInArray(books.id, [ids.get('fl-rejected')!]),
        sql`${books.recordReference} LIKE ${REF + 'fl-%'}`,
      ],
    );
    const keyById = new Map([...ids].map(([k, v]) => [v, k]));
    const keys = rows.map((r) => keyById.get(r.id)!);

    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.id)).size).toBe(50);
    // The real matches lead, then the filler, most popular first: reader
    // activity, then stock depth.
    expect(keys.slice(0, 3).every((k) => k.startsWith('strict-'))).toBe(true);
    expect(keys[3]).toBe('fl-trending');
    expect(keys[4]).toBe('fl-deep');
    expect(keys.slice(5).every((k) => k.startsWith('fl-plain-'))).toBe(true);
    // The two rules the filler never relaxes.
    expect(keys).not.toContain('fl-rejected');
    expect(keys).not.toContain('fl-oos');
  });

  it('returns only what exists when not even the filler can fill the list', async () => {
    const { books } = await import('../db/schema');
    const confine = [feed.buildFeedCondition(), sql`${books.recordReference} LIKE ${REF + 'strict-%'}`];
    const rows = await svc.fetchCandidateBooks(axis(0), confine, ['crime'], confine);
    // Four in-stock strict books, two of them editions of one work — and no
    // repeats to make up the numbers.
    expect(rows).toHaveLength(3);
  });
});
