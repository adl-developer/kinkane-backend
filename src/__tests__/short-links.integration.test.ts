import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Short links end to end, against a real database: an address written into a
 * post is stored once and shown as a short link; sending that short link back
 * in an edit changes nothing; a block reaches every copy; and the redirect
 * counts taps and honours the block.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — it writes rows. Needs
 * Redis (the redirect's rate limiter), and skips when it cannot reach it.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  let configured: string | undefined;
  try {
    configured = dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    configured = undefined;
  }
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error('TEST_DATABASE_URL points at the same database as .env. These tests write rows — point them at a scratch database.');
  }
  process.env.DATABASE_URL = testUrl;
}

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'short-link-test-';
const BOOK_REF = 'short-link-test-book';
const ADDRESS = 'https://www.example.org/short-link-test';

describeIfDb('short links', () => {
  let redisUp = false;
  let db: typeof import('../db').db;
  let sql: typeof import('drizzle-orm').sql;
  let redis: typeof import('../lib/redis').redis;
  let community: typeof import('../services/community.service').communityService;
  let links: typeof import('../services/short-links.service').shortLinksService;
  let harness: Awaited<ReturnType<typeof import('./support/app-harness').startApp>>;
  let ama = 0;
  let kofi = 0;
  let bookId = 0;

  async function cleanUp(): Promise<void> {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    await db.execute(sql`DELETE FROM short_links WHERE url LIKE ${'https://www.example.org/short-link-test%'} OR url LIKE ${'https://medium.com/@sl_test%'}`);
  }

  async function createUser(name: string, username: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, username, email, email_verified)
      VALUES (${name}, ${username}, ${`${EMAIL_PREFIX}${username}@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  beforeAll(async () => {
    ({ redis } = await import('../lib/redis'));
    redisUp = await Promise.race([
      redis.ping().then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!redisUp) return;

    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communityService: community } = await import('../services/community.service'));
    ({ shortLinksService: links } = await import('../services/short-links.service'));
    const { startApp } = await import('./support/app-harness');

    await cleanUp();
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title, isbn13) VALUES (${BOOK_REF}, 'Homegoing', '9781111111112') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
    ama = await createUser('Ama Link', 'sl_ama');
    kofi = await createUser('Kofi Link', 'sl_kofi');
    harness = await startApp();
  }, 60_000);

  afterAll(async () => {
    if (!redisUp) {
      redis?.disconnect();
      return;
    }
    await harness?.close();
    await cleanUp();
    redis.disconnect();
  });

  it('stores an address once and shows it as a short link that round-trips on edit', async (ctx) => {
    if (!redisUp) return ctx.skip();

    const { id: postId } = await community.createPost(ama, {
      bookId, rating: 5, status: 'read', body: `Loved it. Interview: ${ADDRESS}.`, isPublic: true,
    });
    const [stored] = (await db.execute(sql`SELECT body FROM posts WHERE id = ${postId}`)) as unknown as { body: string }[];
    expect(stored.body).toMatch(/^Loved it\. Interview: \{\{l:\d+\}\}\.$/);

    const post = await community.getPost(postId, kofi);
    expect(post.links).toHaveLength(1);
    const [link] = post.links;
    expect(link).toMatchObject({ target: ADDRESS, domain: 'example.org', blocked: false });
    expect(post.body!.slice(link.start, link.start + link.length)).toBe(link.url);
    expect(link.url).toMatch(/\/l\/[0-9A-Z]{8}$/);

    // The app sends back exactly what it was shown: not an edit.
    const updated = await community.updatePost(postId, ama, { body: post.body });
    expect(updated.isEdited).toBe(false);

    // Text changed around the link: an edit, and still the same link.
    const edited = await community.updatePost(postId, ama, { body: `${post.body} Worth it.` });
    expect(edited.isEdited).toBe(true);
    expect(edited.links[0].url).toBe(link.url);

    // The same address in someone else's comment gets the same short link.
    const { id: commentId } = await community.addComment(postId, kofi, `Same one: ${ADDRESS}`);
    const { comments } = await community.listComments(postId, kofi, 20, 0);
    expect(comments.find((c) => c.id === commentId)!.links[0].url).toBe(link.url);
  });

  it('does not read an @ inside an address as a mention', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const { id: postId } = await community.createPost(ama, {
      bookId, rating: 4, status: 'read', body: 'By https://medium.com/@sl_kofi/review', isPublic: true,
    });
    const post = await community.getPost(postId, kofi);
    expect(post.mentions).toEqual([]);
    expect(post.links[0].target).toBe('https://medium.com/@sl_kofi/review');
  });

  it('counts taps, and a block stops the redirect and hides the address everywhere', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const keys = await redis.keys('rl:short-link:*');
    if (keys.length) await redis.del(...keys);

    const [row] = (await db.execute(sql`SELECT code FROM short_links WHERE url = ${ADDRESS}`)) as unknown as { code: string }[];
    const tap = (code: string) => fetch(`${harness.baseUrl}/l/${code}`, { redirect: 'manual' });

    const followed = await tap(row.code.toLowerCase());
    expect(followed.status).toBe(302);
    expect(followed.headers.get('location')).toBe(ADDRESS);
    expect(followed.headers.get('cache-control')).toBe('no-store');
    expect((await links.get(row.code))!.clickCount).toBe(1);

    await links.setBlocked(row.code, true, 'test');
    const blocked = await tap(row.code);
    expect(blocked.status).toBe(410);
    expect(await blocked.text()).not.toContain('example.org');
    expect((await links.get(row.code))!.clickCount).toBe(1);

    const [post] = (await db.execute(sql`SELECT id FROM posts WHERE user_id = ${ama} ORDER BY id LIMIT 1`)) as unknown as { id: number }[];
    const shown = await community.getPost(post.id, kofi);
    expect(shown.links[0]).toMatchObject({ blocked: true, target: null, domain: null });

    expect((await tap('ZZZZZZZZ')).status).toBe(404);
    await links.setBlocked(row.code, false, null);
  });
});
