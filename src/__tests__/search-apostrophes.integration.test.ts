import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Search matches a title whichever apostrophe was typed, against a real Postgres.
 *
 * WHY THIS EXISTS. iOS sends ’ when someone types ', and the catalogue stores both. The
 * fix leans on two things only Postgres decides: that LIKE's `_` matches either character
 * (through ILIKE and the lower() LIKE prefix tier), and that a tsquery OR'd across both
 * spellings matches a tsvector built from either. escape-like.test.ts and tsquery.test.ts
 * only check the strings we build.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite inserts and deletes
 * rows, and `.env` may point at production. Skips itself when unset; refuses to run when
 * it names the same database as `.env`. Setup as in nielsen-budget.integration.test.ts.
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

vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));

type Db = typeof import('../db').db;
let db: Db;
let sql: typeof import('drizzle-orm').sql;
let likePrefix: typeof import('../lib/escape-like').likePrefix;
let likeWordPrefix: typeof import('../lib/escape-like').likeWordPrefix;
let plainTsQuery: typeof import('../lib/tsquery').plainTsQuery;

const describeIfDb = testUrl ? describe : describe.skip;
const REF_PREFIX = 'search-apostrophes-test-';

// Made-up words no real title contains, so each probe only sees this suite's rows.
describeIfDb('search: either apostrophe matches either apostrophe', () => {
  const id: Record<string, number> = {};

  async function createBook(ref: string, title: string, longDescription: string | null = null): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO books (record_reference, title, long_description)
      VALUES (${REF_PREFIX + ref}, ${title}, ${longDescription})
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  /** This suite's book ids a title condition matches. */
  async function titleMatches(condition: (title: ReturnType<typeof sql>) => ReturnType<typeof sql>): Promise<number[]> {
    const rows = (await db.execute(sql`
      SELECT id FROM books
      WHERE record_reference LIKE ${REF_PREFIX + '%'} AND ${condition(sql`title`)}
      ORDER BY id
    `)) as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ likePrefix, likeWordPrefix } = await import('../lib/escape-like'));
    ({ plainTsQuery } = await import('../lib/tsquery'));

    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${REF_PREFIX + '%'}`);
    id.straight = await createBook('straight', "The Secret Lives of Baba Zorvegi's Wives");
    id.curly = await createBook('curly', 'The Secret Lives of Baba Zorvegi’s Wives');
    id.described = await createBook('described', 'An Unrelated Title', 'Inside Quimblefort’s house the clocks ran backwards.');
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${REF_PREFIX + '%'}`);
  });

  it('finds both spellings by word prefix, whichever apostrophe is typed', async () => {
    for (const q of ["baba zorvegi's", 'baba zorvegi’s']) {
      expect(await titleMatches((t) => sql`${t} ILIKE ${likeWordPrefix(q)}`)).toEqual([id.straight, id.curly]);
    }
  });

  it('finds both through the lower() LIKE prefix shape the fast tier uses', async () => {
    for (const q of ["the secret lives of baba zorvegi's", 'the secret lives of baba zorvegi’s']) {
      expect(await titleMatches((t) => sql`lower(${t}) LIKE lower(${likePrefix(q)})`)).toEqual([id.straight, id.curly]);
    }
  });

  it('still requires the letters around the apostrophe', async () => {
    expect(await titleMatches((t) => sql`${t} ILIKE ${likeWordPrefix('baba zorvegi’x')}`)).toEqual([]);
  });

  it('matches full text indexed with either apostrophe', async () => {
    const vectorMatches = async (q: string) => {
      const rows = (await db.execute(sql`
        SELECT id FROM books
        WHERE record_reference LIKE ${REF_PREFIX + '%'} AND search_vector @@ ${plainTsQuery('english', q)}
        ORDER BY id
      `)) as unknown as { id: number }[];
      return rows.map((r) => r.id);
    };
    // Title stored straight and curly, queried each way
    expect(await vectorMatches('zorvegi’s')).toEqual([id.straight, id.curly]);
    expect(await vectorMatches("zorvegi's")).toEqual([id.straight, id.curly]);
    // Description stored curly, queried straight — the case a single spelling missed
    expect(await vectorMatches("quimblefort's")).toEqual([id.described]);
  });

  it('ranks with the OR\'d query without a precedence error', async () => {
    const rows = (await db.execute(sql`
      SELECT id, ts_rank(search_vector, ${plainTsQuery('english', 'zorvegi’s')}) AS rank FROM books
      WHERE record_reference LIKE ${REF_PREFIX + '%'} ORDER BY id
    `)) as unknown as { id: number; rank: number }[];
    expect(rows.find((r) => r.id === id.curly)!.rank).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === id.described)!.rank).toBe(0);
  });
});
