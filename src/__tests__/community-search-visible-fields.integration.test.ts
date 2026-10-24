import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Community search matches what the result shows — a post's book title and
 * subtitle, a group's name — and not the long text behind it.
 *
 * WHY THIS EXISTS. Post search used books.search_vector, which also holds the
 * book's long description and ISBN, and group search a vector over the group
 * description. A query then returned every post about any book whose blurb
 * mentioned the word, and every group whose description did — results with no
 * visible link to what was typed. Only Postgres can show what a tsvector holds.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users, and `.env` points at production. Setup as in
 * community-search-wildcards.integration.test.ts.
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
let communitySearchService: typeof import('../services/community-search.service').communitySearchService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'search-visible-fields-test-';
const BOOK_REF_PREFIX = 'search-visible-fields-test-';
const ISBN = '9789999999123';

describeIfDb('community search: only the fields a result shows', () => {
  let me: number;
  let byTitle: number;
  let bySubtitle: number;
  let byBlurb: number;
  let groupByName: number;
  let groupByBlurb: number;

  async function postIds(q: string) {
    const ids = [byTitle, bySubtitle, byBlurb];
    return (await communitySearchService.search(q, 'posts', me, 50, 0)).posts.map((p) => p.id).filter((id) => ids.includes(id));
  }

  async function groupIds(q: string) {
    const ids = [groupByName, groupByBlurb];
    return (await communitySearchService.search(q, 'groups', me, 50, 0)).groups.map((g) => g.id).filter((id) => ids.includes(id));
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communitySearchService } = await import('../services/community-search.service'));

    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${BOOK_REF_PREFIX + '%'}`);

    const [user] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified) VALUES ('Visible Fields', ${EMAIL_PREFIX + 'me@example.com'}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    me = user.id;

    async function post(ref: string, title: string, subtitle: string | null, blurb: string | null, isbn: string | null) {
      const [book] = (await db.execute(sql`
        INSERT INTO books (record_reference, title, subtitle, long_description, isbn13)
        VALUES (${BOOK_REF_PREFIX + ref}, ${title}, ${subtitle}, ${blurb}, ${isbn})
        RETURNING id
      `)) as unknown as { id: number }[];
      const [row] = (await db.execute(sql`
        INSERT INTO posts (user_id, book_id, status, rating, body, is_public)
        VALUES (${me}, ${book.id}, 'read', 4, 'Loved it.', true)
        RETURNING id
      `)) as unknown as { id: number }[];
      return row.id;
    }
    byTitle = await post('title', 'Zorvegian Nights', null, null, null);
    bySubtitle = await post('subtitle', 'A Quiet Year', 'Tales of Zorvegian Winters', null, null);
    byBlurb = await post('blurb', 'Harbour Lights', null, 'A sweeping Zorvegian saga across three generations.', ISBN);

    async function group(name: string, description: string) {
      const [row] = (await db.execute(sql`
        INSERT INTO groups (owner_id, name, description) VALUES (${me}, ${name}, ${description}) RETURNING id
      `)) as unknown as { id: number }[];
      return row.id;
    }
    groupByName = await group('Zorvegian Readers', 'We meet monthly.');
    groupByBlurb = await group('Harbour Book Club', 'Mostly Zorvegian fiction, some poetry.');
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${BOOK_REF_PREFIX + '%'}`);
  });

  it('finds posts by their book title and subtitle, not its description', async () => {
    expect((await postIds('zorvegian')).sort()).toEqual([byTitle, bySubtitle].sort());
  });

  it('does not find a post by its book ISBN', async () => {
    expect(await postIds(ISBN)).toEqual([]);
  });

  it('finds groups by name, not description', async () => {
    expect(await groupIds('zorvegian')).toEqual([groupByName]);
  });

  it('still matches the words of a group name in any order', async () => {
    expect(await groupIds('club harbour')).toEqual([groupByBlurb]);
  });
});
