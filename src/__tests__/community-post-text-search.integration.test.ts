import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Community search finds posts by what people wrote in them, against a real Postgres.
 *
 * WHY THIS EXISTS. Post text is matched through two columns generated in
 * drizzle/0084 — a token-stripped, ICU-lowercased copy of the body and its
 * tsvector. Whether the regex really blanks the stored @mention/link tokens,
 * whether "É" folds under the database's ctype C, and whether a quoted phrase
 * is held to adjacency are all decided by Postgres, so only Postgres can show it.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users, and `.env` points at production. Skips itself when unset; refuses to
 * run when it names the same database as `.env`. Setup as in
 * nielsen-budget.integration.test.ts.
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
const EMAIL_PREFIX = 'post-text-search-test-';
const BOOK_REF_PREFIX = 'post-text-search-test-';

// Made-up words no real post or title will contain, so each search returns
// only this suite's rows.
describeIfDb('community search: posts by their own text', () => {
  let author: number;
  let mentioned: number;
  let plainBook: number;
  let titledBook: number;
  const post: Record<string, number> = {};

  async function createBook(ref: string, title: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF_PREFIX + ref}, ${title}) RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function createPost(bookId: number, body: string, isPublic = true): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO posts (user_id, book_id, status, rating, body, is_public)
      VALUES (${author}, ${bookId}, 'read', 4, ${body}, ${isPublic})
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  /** The ids of this suite's posts a search returns, in order. */
  async function search(q: string): Promise<number[]> {
    const ours = new Set(Object.values(post));
    const result = await communitySearchService.search(q, 'posts', author, 50, 0);
    return result.posts.map((p) => p.id).filter((id) => ours.has(id));
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communitySearchService } = await import('../services/community-search.service'));

    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${BOOK_REF_PREFIX + '%'}`);

    const [a, m] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified) VALUES
        ('Adaeze', ${`${EMAIL_PREFIX}author@example.com`}, true),
        ('Mentioned', ${`${EMAIL_PREFIX}mentioned@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    author = a.id;
    mentioned = m.id;

    plainBook = await createBook('plain', 'An Ordinary Novel');
    titledBook = await createBook('titled', 'Marrowfen Rising');

    post.word = await createPost(plainBook, 'Honestly the most zorbleflux ending I have read.');
    post.stemmed = await createPost(plainBook, 'I kept zorblefluxing about it for weeks');
    post.phrase = await createPost(plainBook, 'A true quillon marrowfen of a book.');
    post.apart = await createPost(plainBook, 'Marrowfen is where it starts; the quillon comes later.');
    post.titleMatch = await createPost(titledBook, 'Nothing more to say.');
    post.accented = await createPost(plainBook, 'Émile Vantrobe would have loved this.');
    post.tokens = await createPost(plainBook, `Ask @{{u:${mentioned}}} about it, see {{l:987654}} — brindlewick`);
    post.hidden = await createPost(plainBook, 'A private skelderwine note', false);
    // As an iPhone types it: curly apostrophe, em dash, ellipsis, emoji
    post.phone = await createPost(plainBook, 'Tolkien\u2019s cravenmoor\u2014truly vespertane\u2026 loved it\u{1F60D}');
    post.slowly = await createPost(plainBook, 'I kept reading thrimbly through the night');
    post.slowlyApart = await createPost(plainBook, 'Thrimbly, I suppose, but reading it was hard');
    // Two title-prefix matches for "zib": the closer title must stay first,
    // even though only the other post also says "zib" in its text.
    const closeTitle = await createBook('zib-close', 'Zib Tales');
    const looseTitle = await createBook('zib-loose', 'Zibbleworth Grange');
    post.closeTitle = await createPost(closeTitle, 'Nothing about that here.');
    post.looseTitle = await createPost(looseTitle, 'zib zib zib, they all said');
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${BOOK_REF_PREFIX + '%'}`);
  });

  it('finds a post by a word in its text, though the book title does not match', async () => {
    expect(await search('zorbleflux')).toContain(post.word);
  });

  it('finds other forms of the word', async () => {
    // "zorblefluxing" is not a substring of post.word, so only stemming finds it
    expect(await search('zorblefluxing')).toEqual(expect.arrayContaining([post.word, post.stemmed]));
  });

  it('finds part of a word', async () => {
    expect(await search('zorblef')).toEqual(expect.arrayContaining([post.word, post.stemmed]));
  });

  it('holds a quoted phrase to those words side by side', async () => {
    const quoted = await search('"quillon marrowfen"');
    expect(quoted).toContain(post.phrase);
    expect(quoted).not.toContain(post.apart);
    // Curly quotes, as a phone keyboard types them, mean the same thing
    expect(await search('“quillon marrowfen”')).not.toContain(post.apart);
  });

  it('matches unquoted words anywhere in the post, exact wording first', async () => {
    const found = await search('quillon marrowfen');
    expect(found).toEqual(expect.arrayContaining([post.phrase, post.apart]));
    expect(found.indexOf(post.phrase)).toBeLessThan(found.indexOf(post.apart));
  });

  it('still ranks a match on the book title above matches in post text', async () => {
    const found = await search('marrowfen');
    expect(found[0]).toBe(post.titleMatch);
    expect(found).toEqual(expect.arrayContaining([post.phrase, post.apart]));
  });

  it('orders title matches by title closeness, not by what the post says', async () => {
    const found = await search('zib');
    expect(found.indexOf(post.closeTitle)).toBeGreaterThanOrEqual(0);
    expect(found.indexOf(post.closeTitle)).toBeLessThan(found.indexOf(post.looseTitle));
  });

  it('ignores case on accented letters, which the database ctype alone would not', async () => {
    expect(await search('émile vantrobe')).toContain(post.accented);
    expect(await search('ÉMILE')).toContain(post.accented);
  });

  it('does not search the stored mention and link tokens', async () => {
    expect(await search('brindlewick')).toContain(post.tokens);
    expect(await search(`{{u:${mentioned}}}`)).not.toContain(post.tokens);
    expect(await search('987654')).not.toContain(post.tokens);

    const [row] = (await db.execute(sql`
      SELECT search_text, search_vector::text AS vector FROM posts WHERE id = ${post.tokens}
    `)) as unknown as { search_text: string; vector: string }[];
    expect(row.search_text).not.toContain('{{');
    expect(row.vector).not.toContain(String(mentioned));
    expect(row.vector).not.toContain('987654');
  });

  it('keeps the indexed text in step when a post is edited', async () => {
    await db.execute(sql`UPDATE posts SET body = 'Now it is about glimmerhusk' WHERE id = ${post.word}`);
    expect(await search('glimmerhusk')).toContain(post.word);
    expect(await search('zorbleflux')).not.toContain(post.word);
  });

  it('does not read a leading dash or "or" as search operators', async () => {
    // websearch_to_tsquery read "-word" as NOT word, matching every other post
    expect(await search('-zorbleflux')).not.toContain(post.accented);
    expect(await search('-zorbleflux')).not.toContain(post.tokens);
    expect(await search('brindlewick or anything')).not.toContain(post.accented);
  });

  it('splits words at curly apostrophes, dashes, ellipses and emoji', async () => {
    expect(await search('cravenmoor truly')).toContain(post.phone);
    expect(await search('"truly vespertane"')).toContain(post.phone);
    expect(await search('vespertane')).toContain(post.phone);
    // A straight apostrophe finds the curly one, and the other way round
    expect(await search("tolkien's cravenmoor")).toContain(post.phone);
    expect(await search('\u201Cloved it\u201D')).toContain(post.phone);
  });

  it('stems words inside a curly-quoted phrase and holds them together', async () => {
    const found = await search('\u201Cread thrimbly\u201D');
    expect(found).toContain(post.slowly);
    expect(found).not.toContain(post.slowlyApart);
  });

  it('searches stop words quietly instead of printing a Postgres notice', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Matching by exact wording may still find these; only the notice matters
      await search('the');
      await search('"the a"');
      const notices = log.mock.calls.filter(([arg]) => String((arg as { message?: string })?.message ?? '').includes('text-search'));
      expect(notices).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('never returns a private post', async () => {
    expect(await search('skelderwine')).not.toContain(post.hidden);
  });

  it('treats LIKE wildcards in the query as literal characters', async () => {
    expect(await search('%%%')).toEqual([]);
    expect(await search('___')).toEqual([]);
  });
});
