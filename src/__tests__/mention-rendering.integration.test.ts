import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * No endpoint ever hands a client a raw mention token.
 *
 * WHY THIS EXISTS. Mentions are stored as `@{{u:<id>}}` and rendered back into
 * `@username` on the way out (see lib/mention-text.ts). That rendering happens
 * in each read path — the post lists, the comment lists, the group pages, the
 * shelf, the notes — and a read path that forgets it ships `@{{u:4412}}` to the
 * app. Nothing in the types stops that, so this suite does it from the outside:
 * it puts a mention into every kind of text that can hold one, then calls every
 * signed-in GET the app has and fails on any response containing a token.
 *
 * Driven by the live route table, like the endpoint contract suite, so an
 * endpoint added tomorrow is checked tomorrow without anyone remembering to.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — it writes rows. Needs
 * Redis too (the rate limiters and the shelf-note cache), and skips when it
 * cannot reach it rather than hanging.
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
        'These tests write rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
  // Keep the sweep off third parties: no live Nielsen lookups from the book page.
  process.env.NIELSEN_REVIEWS_ENABLED = 'false';
}

// The queues are real: the app mounts them on its admin dashboard. Nothing
// consumes them here — no worker runs in this process — so a queued push or
// email is never sent.

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'mention-render-test-';
const BOOK_REF = 'mention-render-test-book';
const TOKEN = '@{{u:';

/**
 * The parts of the API that can carry user-written text. Everything else —
 * cart, orders, billing, referrals — has none, and /recommendations is left out
 * because it can call Gemini.
 */
const SWEPT_PREFIXES = [
  '/api/v1/community',
  '/api/v1/users',
  '/api/v1/groups',
  '/api/v1/books',
  '/api/v1/user-books',
  '/api/v1/user/',
  '/api/v1/explore',
  '/api/v1/saved-books',
];
const SKIPPED_PREFIXES = ['/api/v1/user/subscription'];

describeIfDb('mention rendering across the API', () => {
  let redisUp = false;
  let harness: Awaited<ReturnType<typeof import('./support/app-harness').startApp>>;
  let db: typeof import('../db').db;
  let sql: typeof import('drizzle-orm').sql;
  let redis: typeof import('../lib/redis').redis;
  const params: Record<string, string> = {};
  let token = '';

  async function cleanUp(): Promise<void> {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
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
    const { communityService } = await import('../services/community.service');
    const { groupsService } = await import('../services/groups.service');
    const { groupBooksService } = await import('../services/group-books.service');
    const { userBooksService } = await import('../services/user-books.service');
    const { signAccessToken } = await import('../services/auth.service');
    const { startApp } = await import('./support/app-harness');

    await cleanUp();
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title, isbn13) VALUES (${BOOK_REF}, 'Homegoing', '9781111111111') RETURNING id
    `)) as unknown as { id: number }[];
    const ama = await createUser('Ama Render', 'mtr_ama');
    const kofi = await createUser('Kofi Render', 'mtr_kofi');
    // Kofi follows Ama, so her book detail and shelf are open to him.
    await db.execute(sql`INSERT INTO follow_requests (sender_id, receiver_id, status) VALUES (${kofi}, ${ama}, 'accepted')`);

    // A mention in every kind of text that can hold one, all of it public.
    const { id: postId } = await communityService.createPost(ama, {
      bookId: book.id, rating: 5, status: 'read', body: 'Read it with @mtr_kofi', isPublic: true,
    });
    const { id: commentId } = await communityService.addComment(postId, kofi, 'Thanks @mtr_ama');
    const group = await groupsService.create(kofi, { name: 'Render Club', description: 'Run with @mtr_ama', privacy: 'public' });
    const shelf = await groupBooksService.setCurrent(group.id, kofi, {
      bookId: book.id, startedOn: '2026-10-01', description: 'Picked by @mtr_ama',
    });
    const groupComment = await groupBooksService.addComment(group.id, shelf.id, kofi, 'Over to you @mtr_ama');
    await userBooksService.upsert(ama, book.id, { status: 'read', note: 'Lent to @mtr_kofi', noteIsPublic: true });
    await userBooksService.upsert(kofi, book.id, { status: 'reading', note: 'Ask @mtr_ama', noteIsPublic: false });

    Object.assign(params, {
      ':id': String(book.id),
      ':bookId': String(book.id),
      ':isbn': '9781111111111',
      ':postId': String(postId),
      ':groupId': String(group.id),
      ':groupBookId': String(shelf.id),
      ':userId': String(ama),
      ':friendId': String(ama),
      ':username': 'mtr_ama',
      // Resolved per route below: a comment id means different tables under
      // /community and /groups.
      'communityComment': String(commentId),
      'groupComment': String(groupComment.id),
    });
    token = signAccessToken(kofi, `${EMAIL_PREFIX}mtr_kofi@example.com`);
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

  function concrete(path: string): string {
    return path
      .split('/')
      .map((seg) => {
        if (seg === ':commentId') return path.includes('/groups/') ? params.groupComment : params.communityComment;
        return seg.startsWith(':') ? (params[seg] ?? '999999999') : seg;
      })
      .join('/');
  }

  it('never returns a stored mention token from any signed-in read', async (ctx) => {
    if (!redisUp) return ctx.skip();

    const { listRoutes } = await import('./support/route-inventory');
    const { default: app } = await import('../app');
    const routes = listRoutes(app).filter(
      (r) =>
        r.method === 'GET' &&
        SWEPT_PREFIXES.some((p) => r.path.startsWith(p)) &&
        !SKIPPED_PREFIXES.some((p) => r.path.startsWith(p)),
    );

    const leaked: string[] = [];
    const rendered = new Set<string>();
    for (const route of routes) {
      // Rate limits are not what this measures.
      const keys = await redis.keys('rl:*');
      if (keys.length) await redis.del(...keys);

      const res = await fetch(`${harness.baseUrl}${concrete(route.path)}`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
      });
      const body = await res.text();
      if (body.includes(TOKEN)) leaked.push(`GET ${route.path} -> ${body.slice(body.indexOf(TOKEN) - 40, body.indexOf(TOKEN) + 20)}`);
      if (/@mtr_(ama|kofi)/.test(body)) rendered.add(route.path);
    }

    expect(leaked, `responses containing a raw mention token:\n${leaked.join('\n')}`).toEqual([]);

    // The sweep is only worth something if it reached the seeded text. One
    // route per kind of source, so a broken seed fails loudly instead of the
    // suite passing on empty pages.
    expect([...rendered]).toEqual(
      expect.arrayContaining([
        '/api/v1/community/posts/:postId',
        '/api/v1/community/posts/:postId/comments',
        '/api/v1/groups/:groupId',
        '/api/v1/groups/:groupId/books/:groupBookId',
        '/api/v1/groups/:groupId/books/:groupBookId/comments',
        '/api/v1/books/:id',
      ]),
    );
  }, 120_000);
});
