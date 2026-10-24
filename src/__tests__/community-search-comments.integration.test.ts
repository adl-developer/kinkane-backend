import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/**
 * Community post search finds a post by what people wrote in its comments,
 * against a real Postgres.
 *
 * WHY THIS EXISTS. The comment test reads generated columns (drizzle/0092) and
 * the same visibility rules as the comment thread — hidden, blocked and
 * blacklisted comments must not pull a post in, or it turns up for a reason
 * the searcher cannot find on it. Only Postgres can show what those columns
 * hold and what the visibility joins let through.
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
const EMAIL_PREFIX = 'search-comments-test-';
const BOOK_REF_PREFIX = 'search-comments-test-';

describeIfDb('community search: comments', () => {
  const ids: Record<string, number> = {};
  const postIds: number[] = [];

  async function search(q: string, as = ids.me) {
    const { posts } = await communitySearchService.search(q, 'posts', as, 50, 0);
    return posts.filter((p) => postIds.includes(p.id));
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communitySearchService } = await import('../services/community-search.service'));

    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${BOOK_REF_PREFIX + '%'}`);

    for (const key of ['me', 'author', 'commenter', 'blocked', 'banned']) {
      const [row] = (await db.execute(sql`
        INSERT INTO users (name, email, email_verified) VALUES (${'Comments ' + key}, ${`${EMAIL_PREFIX}${key}@example.com`}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      ids[key] = row.id;
    }
    await db.execute(sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${ids.me}, ${ids.blocked})`);
    await db.execute(sql`UPDATE users SET blacklisted_at = now() WHERE id = ${ids.banned}`);

    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF_PREFIX + 'book'}, 'Harbour Lights') RETURNING id
    `)) as unknown as { id: number }[];

    async function post(key: string, body: string, isPublic = true) {
      const [row] = (await db.execute(sql`
        INSERT INTO posts (user_id, book_id, status, rating, body, is_public)
        VALUES (${ids.author}, ${book.id}, 'read', 4, ${body}, ${isPublic})
        RETURNING id
      `)) as unknown as { id: number }[];
      ids[key] = row.id;
      postIds.push(row.id);
    }
    async function comment(postKey: string, by: string, body: string, hidden = false) {
      const [row] = (await db.execute(sql`
        INSERT INTO comments (post_id, user_id, body, hidden_at)
        VALUES (${ids[postKey]}, ${ids[by]}, ${body}, ${hidden ? sql`now()` : null})
        RETURNING id
      `)) as unknown as { id: number }[];
      return row.id;
    }

    await post('inBody', 'A Zorvegian triumph.');
    await post('inComment', 'Loved it.');
    await post('hiddenOnly', 'Fine.');
    await post('blockedOnly', 'Okay.');
    await post('bannedOnly', 'Good.');
    await post('private', 'Mine.', false);
    await post('blockerOnly', 'Hm.');

    await comment('inBody', 'commenter', 'Zorvegian indeed.');
    ids.firstComment = await comment('inComment', 'commenter', 'The Zorvegian chapters were slow.');
    ids.bestComment = await comment('inComment', 'commenter', 'Zorvegian, Zorvegian, Zorvegian — so Zorvegian.');
    await comment('hiddenOnly', 'commenter', 'Zorvegian spam.', true);
    await comment('blockedOnly', 'blocked', 'Zorvegian from someone I blocked.');
    await comment('bannedOnly', 'banned', 'Zorvegian from a blacklisted account.');
    await comment('private', 'commenter', 'Zorvegian under a private post.');
    await comment('blockerOnly', 'me', 'Zorvegian from the person who did the blocking.');
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${BOOK_REF_PREFIX + '%'}`);
  });

  it('finds a post by a word in one of its comments, after posts that say it themselves', async () => {
    const found = (await search('zorvegian')).map((p) => p.id);
    expect(found[0]).toBe(ids.inBody);
    expect(found.slice(1).sort()).toEqual([ids.inComment, ids.blockerOnly].sort());
  });

  it('returns the comment that matched, only when the post itself did not', async () => {
    const found = await search('zorvegian');
    const inComment = found.find((p) => p.id === ids.inComment)!;
    expect(found[0].matchedComment).toBeNull();
    expect(inComment.matchedComment).toMatchObject({ id: ids.bestComment, userId: ids.commenter, userName: 'Comments commenter' });
  });

  it('matches part words and quoted phrases in comments, as in posts', async () => {
    expect((await search('zorveg')).map((p) => p.id)).toContain(ids.inComment);
    expect((await search('"chapters were slow"')).map((p) => p.id)).toEqual([ids.inComment]);
    expect(await search('"slow chapters"')).toEqual([]);
  });

  it('ignores hidden comments, comments across a block and blacklisted accounts', async () => {
    const found = (await search('zorvegian')).map((p) => p.id);
    expect(found).not.toContain(ids.hiddenOnly);
    expect(found).not.toContain(ids.blockedOnly);
    expect(found).not.toContain(ids.bannedOnly);
  });

  it('applies a block in either direction', async () => {
    // The blocked person still finds their own comment, but not the blocker's.
    const found = (await search('zorvegian', ids.blocked)).map((p) => p.id);
    expect(found).toContain(ids.blockedOnly);
    expect(found).not.toContain(ids.blockerOnly);
  });

  it('never surfaces a private post through its comments', async () => {
    expect((await search('zorvegian')).map((p) => p.id)).not.toContain(ids.private);
  });
});
