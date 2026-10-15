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
// Links shown the way production shows them. APP_URL stays whatever the
// environment says, so links in the original APP_URL/l form can be checked too.
process.env.SHORT_LINK_URL = 'https://www.kinkane.app/s';

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
    await db.execute(sql`
      DELETE FROM short_links
      WHERE url LIKE ${'https://www.example.org/short-link-test%'} OR url LIKE ${'https://medium.com/@sl_%'}
         OR url LIKE ${'%short-link-test.example%'} OR url = ${'https://www.slt.example/'}
    `);
    await db.execute(sql`DELETE FROM blocked_link_domains WHERE domain = ${'short-link-test.example'}`);
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
    expect(link.url).toMatch(/^https:\/\/www\.kinkane\.app\/s\/[0-9A-Z]{8}$/);

    // The app sends back exactly what it was shown: not an edit.
    const updated = await community.updatePost(postId, ama, { body: post.body });
    expect(updated.isEdited).toBe(false);

    // The same link sent back in its original APP_URL/l form (from an older
    // copy of the text): the same stored link, so the post is unchanged.
    const { config } = await import('../config');
    const code = link.url.split('/').pop()!;
    const oldForm = post.body!.replace(link.url, `${config.appUrl}/l/${code}`);
    const resent = await community.updatePost(postId, ama, { body: oldForm });
    expect(resent.isEdited).toBe(false);
    expect(resent.body).toBe(post.body);

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
    const tap = (code: string, path = 's') => fetch(`${harness.baseUrl}/${path}/${code}`, { redirect: 'manual' });

    const followed = await tap(row.code.toLowerCase());
    expect(followed.status).toBe(302);
    expect(followed.headers.get('location')).toBe(ADDRESS);
    expect(followed.headers.get('cache-control')).toBe('no-store');
    // The original /l/ form still works, for links already shared.
    const old = await tap(row.code, 'l');
    expect(old.status).toBe(302);
    expect(old.headers.get('location')).toBe(ADDRESS);
    expect((await links.get(row.code))!.clickCount).toBe(2);

    await links.setBlocked(row.code, true, 'test');
    const blocked = await tap(row.code);
    expect(blocked.status).toBe(410);
    expect(await blocked.text()).not.toContain('example.org');
    expect((await links.get(row.code))!.clickCount).toBe(2);

    const [post] = (await db.execute(sql`SELECT id FROM posts WHERE user_id = ${ama} ORDER BY id LIMIT 1`)) as unknown as { id: number }[];
    const shown = await community.getPost(post.id, kofi);
    expect(shown.links[0]).toMatchObject({ blocked: true, target: null, domain: null });

    expect((await tap('ZZZZZZZZ')).status).toBe(404);
    await links.setBlocked(row.code, false, null);
  });

  it('does not read an @ in an address past the link cap as a mention', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const five = [1, 2, 3, 4, 5].map((n) => `https://www.example.org/short-link-test/cap${n}`).join(' ');
    const { id: postId } = await community.createPost(ama, {
      bookId, rating: 3, status: 'read', body: `${five} https://medium.com/@sl_kofi/sixth`, isPublic: true,
    });
    const post = await community.getPost(postId, kofi);
    expect(post.links).toHaveLength(5);
    expect(post.mentions).toEqual([]);
    expect(post.body).toContain('https://medium.com/@sl_kofi/sixth');
    const rows = (await db.execute(sql`SELECT 1 FROM mentions WHERE post_id = ${postId}`)) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('writes no short links for an edit that is refused or changes nothing', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const intruder = 'https://www.example.org/short-link-test/intruder';
    const [post] = (await db.execute(sql`SELECT id FROM posts WHERE user_id = ${ama} ORDER BY id LIMIT 1`)) as unknown as { id: number }[];
    await expect(community.updatePost(post.id, kofi, { body: `mine now ${intruder}` })).rejects.toMatchObject({ statusCode: 404 });
    const rows = (await db.execute(sql`SELECT 1 FROM short_links WHERE url = ${intruder}`)) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('refuses text that would read longer than the limit once its links are shortened, storing nothing', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const [post] = (await db.execute(sql`SELECT id FROM posts WHERE user_id = ${ama} ORDER BY id LIMIT 1`)) as unknown as { id: number }[];
    // 1996 characters as typed (under the 2000 comment limit), but the
    // 15-character address shows as a 34-character short link: 2015.
    const body = `${'x'.repeat(1980)} www.slt.example`;
    await expect(community.addComment(post.id, kofi, body)).rejects.toMatchObject({ statusCode: 400, code: 'TEXT_TOO_LONG' });
    const rows = (await db.execute(sql`SELECT 1 FROM short_links WHERE url = ${'https://www.slt.example/'}`)) as unknown as unknown[];
    expect(rows).toHaveLength(0);
  });

  it('a blocked domain covers every address on it and its subdomains', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const { id: postId } = await community.createPost(ama, {
      bookId, rating: 2, status: 'read', body: 'Phish https://login.short-link-test.example/a?x=1', isPublic: true,
    });
    const before = await community.getPost(postId, kofi);
    expect(before.links[0].blocked).toBe(false);

    await links.blockDomain('short-link-test.example', 'test');
    const after = await community.getPost(postId, kofi);
    expect(after.links[0]).toMatchObject({ blocked: true, target: null });

    const code = after.links[0].url.split('/').pop()!;
    const keys = await redis.keys('rl:short-link:*');
    if (keys.length) await redis.del(...keys);
    const tapped = await fetch(`${harness.baseUrl}/s/${code}`, { redirect: 'manual' });
    expect(tapped.status).toBe(410);
    expect((await links.get(code))!.clickCount).toBe(0);

    // A variant posted after the block is blocked too.
    const { id: laterId } = await community.createPost(ama, {
      bookId, rating: 2, status: 'read', body: 'Again https://short-link-test.example/b?y=2', isPublic: true,
    });
    expect((await community.getPost(laterId, kofi)).links[0].blocked).toBe(true);

    expect(await links.unblockDomain('short-link-test.example')).toBe(true);
    expect((await community.getPost(postId, kofi)).links[0].blocked).toBe(false);
  });

  it('shows the short link, not the typed address, in the new-comment notification', async (ctx) => {
    if (!redisUp) return ctx.skip();
    const [post] = (await db.execute(sql`SELECT id FROM posts WHERE user_id = ${ama} ORDER BY id LIMIT 1`)) as unknown as { id: number }[];
    await community.addComment(post.id, kofi, 'Notify https://www.example.org/short-link-test/notify');
    // The notification is sent in the background.
    let preview: string | undefined;
    for (let i = 0; i < 20 && !preview?.includes('Notify'); i++) {
      const [row] = (await db.execute(sql`
        SELECT data->>'commentPreview' AS preview FROM notifications
        WHERE user_id = ${ama} AND type = 'post_comment' ORDER BY id DESC LIMIT 1
      `)) as unknown as { preview: string }[];
      preview = row?.preview;
      if (!preview?.includes('Notify')) await new Promise((r) => setTimeout(r, 100));
    }
    expect(preview).toMatch(/^Notify https:\/\/www\.kinkane\.app\/s\/[0-9A-Z]{8}$/);
  });
});
