import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * Blocking, end to end against a real Postgres: the endpoints over HTTP, and
 * every place a block has to reach — profile, follows, feed, comments, search,
 * tagging, the mentions list, notifications and a shared book club.
 *
 * Most of what a block does is a filter added to an existing query, so the
 * thing worth proving is that each of those queries really has it, in both
 * directions. Every check below is run from both sides of the block.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users. Skips itself when unset; refuses to run when it names the same
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

// The caller is whoever the x-test-user header names.
vi.mock('../middleware/auth.middleware', () => {
  const asHeaderUser = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: { id: number; email: string } }).user = {
      id: Number(req.headers['x-test-user']),
      email: 'test@example.com',
    };
    next();
  };
  return { requireAuth: asHeaderUser, optionalAuth: asHeaderUser };
});
vi.mock('../middleware/rate-limit.middleware', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { followRequestLimiter: pass, usernameCheckLimiter: pass };
});
vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification-preferences.service', () => ({
  notificationPreferencesService: { isEnabled: vi.fn().mockResolvedValue(false) },
}));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let usersService: typeof import('../services/users.service').usersService;
let communityService: typeof import('../services/community.service').communityService;
let searchService: typeof import('../services/community-search.service').communitySearchService;
let suggestions: typeof import('../services/mention-suggestions.service').mentionSuggestionsService;
let mentionsService: typeof import('../services/mentions.service').mentionsService;
let groupsService: typeof import('../services/groups.service').groupsService;
let groupBooksService: typeof import('../services/group-books.service').groupBooksService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'block-test-';
const BOOK_REF = 'block-test-book';

describeIfDb('blocking a user', () => {
  let server: Server;
  let base: string;
  let bookId: number;
  // Ama blocks Kofi in most tests; Esi is a bystander both of them know.
  let ama: number;
  let kofi: number;
  let esi: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ usersService } = await import('../services/users.service'));
    ({ communityService } = await import('../services/community.service'));
    ({ communitySearchService: searchService } = await import('../services/community-search.service'));
    ({ mentionSuggestionsService: suggestions } = await import('../services/mention-suggestions.service'));
    ({ mentionsService } = await import('../services/mentions.service'));
    ({ groupsService } = await import('../services/groups.service'));
    ({ groupBooksService } = await import('../services/group-books.service'));
    // Run mention notifications only when a test asks for them.
    vi.spyOn(mentionsService, 'dispatchInBackground').mockImplementation(() => {});

    const { default: usersRoutes } = await import('../routes/users.routes');
    const app = express();
    app.use(express.json());
    app.use('/users', usersRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'Beloved') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
  });

  async function cleanUp(): Promise<void> {
    // Cascades through blocks, follows, posts, comments, groups, mentions and notifications.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
  }

  async function createUser(name: string, username: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, username, email, email_verified, shelf_visibility)
      VALUES (${name}, ${username}, ${`${EMAIL_PREFIX}${username}@example.com`}, true, 'public')
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function befriend(a: number, b: number): Promise<void> {
    await db.execute(sql`INSERT INTO follow_requests (sender_id, receiver_id, status) VALUES (${a}, ${b}, 'accepted')`);
  }

  async function call(caller: number, method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-test-user': String(caller), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const block = (blocker: number, blocked: number, reason?: string) =>
    call(blocker, 'POST', `/users/${blocked}/block`, reason === undefined ? {} : { reason });

  async function post(userId: number, body: string): Promise<number> {
    const { id } = await communityService.createPost(userId, { bookId, status: 'read', rating: 4, body, isPublic: true });
    return id;
  }

  async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
    try {
      await promise;
      return 'ok';
    } catch (err) {
      return (err as { statusCode?: number }).statusCode ?? 500;
    }
  }

  beforeEach(async () => {
    await cleanUp();
    ama = await createUser('Ama Owusu', 'bt_ama');
    kofi = await createUser('Kofi Mensah', 'bt_kofi');
    esi = await createUser('Esi Boateng', 'bt_esi');
  });

  afterAll(async () => {
    await cleanUp();
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    await new Promise((resolve) => server.close(resolve));
  });

  // ── The endpoints ──────────────────────────────────────────────────────────

  it('blocks with a reason, lists the block, and is safe to repeat', async () => {
    const first = await block(ama, kofi, 'Harassment');
    expect(first.status).toBe(201);
    expect(first.body.block).toMatchObject({ id: kofi, name: 'Kofi Mensah', username: 'bt_kofi', reason: 'Harassment' });

    // A second tap keeps the original block and its reason.
    const again = await block(ama, kofi, 'Spam');
    expect(again.status).toBe(201);
    expect(again.body.block).toMatchObject({ reason: 'Harassment' });

    const list = await call(ama, 'GET', '/users/blocks');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, items: [{ id: kofi, reason: 'Harassment' }] });
    // The list is the blocker's alone.
    expect((await call(kofi, 'GET', '/users/blocks')).body).toMatchObject({ total: 0 });
  });

  it('allows blocking without a reason', async () => {
    const res = await block(ama, kofi);
    expect(res.status).toBe(201);
    expect(res.body.block).toMatchObject({ reason: null });
  });

  it('refuses blocking yourself or someone who does not exist', async () => {
    expect((await block(ama, ama)).status).toBe(400);
    expect((await block(ama, 999_999_999)).status).toBe(404);
  });

  it('lets only the blocker unblock', async () => {
    await block(ama, kofi);
    expect((await call(kofi, 'DELETE', `/users/${ama}/block`)).status).toBe(404);
    expect((await call(ama, 'DELETE', `/users/${kofi}/block`)).status).toBe(200);
    expect((await call(ama, 'DELETE', `/users/${kofi}/block`)).status).toBe(404);
  });

  // ── Profile and follows ────────────────────────────────────────────────────

  it('shows each side the limited profile, with Blocked on the blocker’s button', async () => {
    await befriend(ama, kofi);
    await block(ama, kofi);

    const seenByAma = (await call(ama, 'GET', `/users/${kofi}`)).body;
    expect(seenByAma).toMatchObject({
      id: kofi,
      name: 'Kofi Mensah',
      followStatus: 'blocked',
      isBlocked: true,
      hasBlockedYou: false,
      canViewShelf: false,
      incomingFollowRequest: null,
    });
    expect(seenByAma).not.toHaveProperty('followerCount');

    const seenByKofi = (await call(kofi, 'GET', `/users/${ama}`)).body;
    expect(seenByKofi).toMatchObject({
      id: ama,
      followStatus: 'none',
      isBlocked: false,
      hasBlockedYou: true,
      canViewShelf: false,
    });
    expect(seenByKofi).not.toHaveProperty('followerCount');

    // Nothing past the limited profile, from either side.
    for (const [viewer, target] of [[ama, kofi], [kofi, ama]]) {
      expect((await call(viewer, 'GET', `/users/${target}/books`)).status).toBe(404);
      expect((await call(viewer, 'GET', `/users/${target}/followers`)).status).toBe(404);
      expect((await call(viewer, 'GET', `/users/${target}/groups`)).status).toBe(404);
    }
  });

  it('removes follows both ways and refuses new ones', async () => {
    await befriend(ama, kofi);
    await befriend(kofi, ama);
    await block(ama, kofi);

    const [{ count }] = (await db.execute(sql`
      SELECT count(*)::int AS count FROM follow_requests
      WHERE (sender_id = ${ama} AND receiver_id = ${kofi}) OR (sender_id = ${kofi} AND receiver_id = ${ama})
    `)) as unknown as { count: number }[];
    expect(count).toBe(0);

    const fromKofi = await call(kofi, 'POST', `/users/${ama}/follow`);
    expect(fromKofi).toMatchObject({ status: 403, body: { code: 'BLOCKED' } });
    const fromAma = await call(ama, 'POST', `/users/${kofi}/follow`);
    expect(fromAma).toMatchObject({ status: 403, body: { code: 'BLOCKED' } });
  });

  it('clears the notifications each had about the other, and only those', async () => {
    await db.execute(sql`
      INSERT INTO notifications (user_id, type, data) VALUES
        (${ama}, 'post_like', ${JSON.stringify({ likerId: kofi })}::jsonb),
        (${kofi}, 'mention', ${JSON.stringify({ mentionerId: ama })}::jsonb),
        (${ama}, 'post_like', ${JSON.stringify({ likerId: esi })}::jsonb)
    `);
    await block(ama, kofi);

    const left = (await db.execute(sql`
      SELECT user_id, data FROM notifications WHERE user_id IN (${ama}, ${kofi})
    `)) as unknown as { user_id: number; data: Record<string, unknown> }[];
    expect(left).toEqual([{ user_id: ama, data: { likerId: esi } }]);
  });

  it('brings the profile back on unblock, without the follow', async () => {
    await befriend(ama, kofi);
    await block(ama, kofi);
    await call(ama, 'DELETE', `/users/${kofi}/block`);

    const profile = await usersService.getUserProfile(kofi, ama);
    expect(profile).toMatchObject({ followStatus: 'none', isBlocked: false, hasBlockedYou: false, canViewShelf: true });
    expect((await call(ama, 'POST', `/users/${kofi}/follow`)).status).toBe(201);
  });

  // ── Feed, posts and comments ──────────────────────────────────────────────

  it('hides each side’s posts from the other in the feed, the book page and by id', async () => {
    const amaPost = await post(ama, 'Ama on Beloved');
    const kofiPost = await post(kofi, 'Kofi on Beloved');
    const esiPost = await post(esi, 'Esi on Beloved');
    await block(ama, kofi);

    const ids = async (viewer: number) => (await communityService.listPosts(viewer, 'date_desc', 50, 0)).posts.map((p) => p.id);
    expect(await ids(ama)).toEqual(expect.arrayContaining([amaPost, esiPost]));
    expect(await ids(ama)).not.toContain(kofiPost);
    expect(await ids(kofi)).not.toContain(amaPost);
    // A bystander sees everyone.
    expect(await ids(esi)).toEqual(expect.arrayContaining([amaPost, kofiPost, esiPost]));

    const forBook = await communityService.listPostsForBook(bookId, kofi, 'date_desc', 50, 0);
    expect(forBook.posts.map((p) => p.id)).not.toContain(amaPost);
    const reviews = await communityService.listReviewsForBook(bookId, ama, 'date_desc', 50, 0);
    expect(reviews.posts.map((p) => p.id)).not.toContain(kofiPost);

    expect(await status(communityService.getPost(amaPost, kofi))).toBe(404);
    expect(await status(communityService.getPost(kofiPost, ama))).toBe(404);
    expect(await status(communityService.likePost(amaPost, kofi))).toBe(404);
    expect(await status(communityService.addComment(kofiPost, ama, 'hi'))).toBe(404);
  });

  it('hides old comments between the two, on anyone’s post, and counts without them', async () => {
    const esiPost = await post(esi, 'Esi on Beloved');
    const amaPost = await post(ama, 'Ama on Beloved');
    const { id: kofiOnEsi } = await communityService.addComment(esiPost, kofi, 'Kofi here');
    const { id: amaOnEsi } = await communityService.addComment(esiPost, ama, 'Ama here');
    await communityService.addComment(amaPost, kofi, 'Kofi on Ama’s post');
    await block(ama, kofi);

    const forAma = await communityService.listComments(esiPost, ama, 50, 0);
    expect(forAma.comments.map((c) => c.id)).toEqual([amaOnEsi]);
    expect(forAma.total).toBe(1);
    const forKofi = await communityService.listComments(esiPost, kofi, 50, 0);
    expect(forKofi.comments.map((c) => c.id)).toEqual([kofiOnEsi]);
    expect((await communityService.getPost(esiPost, ama)).commentCount).toBe(1);
    expect((await communityService.getPost(esiPost, esi)).commentCount).toBe(2);

    // Ama's own post no longer shows Kofi's comment to her.
    expect((await communityService.listComments(amaPost, ama, 50, 0)).total).toBe(0);
    expect(await status(communityService.likeComment(kofiOnEsi, ama))).toBe(404);
  });

  // ── Search and tagging ────────────────────────────────────────────────────

  it('keeps each side out of the other’s search, both people and posts', async () => {
    await post(kofi, 'A gripping read');
    await post(ama, 'A gripping read too');
    await block(ama, kofi);

    const amaSearch = await searchService.search('Kofi', 'users', ama, 20, 0);
    expect(amaSearch.users).toHaveLength(0);
    const kofiSearch = await searchService.search('@bt_ama', 'users', kofi, 20, 0);
    expect(kofiSearch.users).toHaveLength(0);
    // Esi still finds Kofi.
    expect((await searchService.search('Kofi', 'users', esi, 20, 0)).users.map((u) => u.id)).toEqual([kofi]);

    const posts = await searchService.search('gripping', 'posts', ama, 20, 0);
    expect(posts.posts.map((p) => p.userId)).toEqual([ama]);
    expect(posts.total.posts).toBe(1);
  });

  it('stops each side tagging the other', async () => {
    await befriend(ama, kofi);
    await block(kofi, ama);

    expect((await suggestions.suggest(ama, 'bt_k')).map((s) => s.id)).toEqual([]);
    expect((await suggestions.suggest(kofi, 'bt_a')).map((s) => s.id)).toEqual([]);

    const esiPost = await post(esi, 'Esi on Beloved');
    await communityService.addComment(esiPost, ama, 'Agree with @bt_kofi and @bt_esi');
    const { comments } = await communityService.listComments(esiPost, esi, 10, 0);
    // Kofi stays the plain text Ama typed; Esi is linked.
    expect(comments[0].body).toBe('Agree with @bt_kofi and @bt_esi');
    expect(comments[0].mentions.map((m) => m.userId)).toEqual([esi]);

    const [{ count }] = (await db.execute(sql`
      SELECT count(*)::int AS count FROM mentions WHERE mentioned_user_id = ${kofi}
    `)) as unknown as { count: number }[];
    expect(count).toBe(0);
  });

  it('hides old mentions by the other person from the mentions list', async () => {
    const esiPost = await post(esi, 'Esi on Beloved');
    const { id: commentId } = await communityService.addComment(esiPost, kofi, 'Ask @bt_ama');
    await mentionsService.dispatch({ type: 'comment', id: commentId });
    expect((await mentionsService.list(ama, 20, 0)).total).toBe(1);

    await block(ama, kofi);
    expect(await mentionsService.list(ama, 20, 0)).toMatchObject({ total: 0, mentions: [] });
  });

  // ── A book club they share ────────────────────────────────────────────────

  it('in a shared group, shows each other’s comments but refuses replies and likes', async () => {
    const group = await groupsService.create(esi, { name: 'Night Readers', privacy: 'public' });
    await db.execute(sql`
      INSERT INTO group_memberships (group_id, user_id, status, joined_at)
      VALUES (${group.id}, ${ama}, 'active', now()), (${group.id}, ${kofi}, 'active', now())
    `);
    const shelf = await groupBooksService.setCurrent(group.id, esi, { bookId, startedOn: '2026-10-01' });
    const kofiComment = await groupBooksService.addComment(group.id, shelf.id, kofi, 'Kofi’s thoughts');
    const amaComment = await groupBooksService.addComment(group.id, shelf.id, ama, 'Ama’s thoughts');
    await block(ama, kofi);

    const forAma = await groupBooksService.listComments(group.id, shelf.id, ama, 20, 0);
    expect(forAma.total).toBe(2);
    expect(Object.fromEntries(forAma.comments.map((c) => [c.id, c.authorBlocked]))).toEqual({
      [kofiComment.id]: true,
      [amaComment.id]: false,
    });
    const forEsi = await groupBooksService.listComments(group.id, shelf.id, esi, 20, 0);
    expect(forEsi.comments.every((c) => !c.authorBlocked)).toBe(true);

    const refused = (p: Promise<unknown>) => p.then(() => null, (e: { statusCode?: number; code?: string }) => [e.statusCode, e.code]);
    expect(await refused(groupBooksService.addComment(group.id, shelf.id, ama, 'Reply', kofiComment.id))).toEqual([403, 'BLOCKED']);
    expect(await refused(groupBooksService.addComment(group.id, shelf.id, kofi, 'Reply', amaComment.id))).toEqual([403, 'BLOCKED']);
    expect(await refused(groupBooksService.likeComment(group.id, kofiComment.id, ama))).toEqual([403, 'BLOCKED']);
    expect(await refused(groupBooksService.likeComment(group.id, amaComment.id, kofi))).toEqual([403, 'BLOCKED']);

    // Esi can still reply to either, and each can still post top-level.
    expect(await status(groupBooksService.addComment(group.id, shelf.id, esi, 'Reply', kofiComment.id))).toBe('ok');
    expect(await status(groupBooksService.addComment(group.id, shelf.id, kofi, 'Another thought'))).toBe('ok');
  });

  it('drops pending invitations between the two and refuses new ones', async () => {
    const group = await groupsService.create(ama, { name: 'Night Readers', privacy: 'private' });
    await groupsService.invite(group.id, ama, [kofi]);
    await block(kofi, ama);

    const [{ count }] = (await db.execute(sql`
      SELECT count(*)::int AS count FROM group_memberships WHERE group_id = ${group.id} AND user_id = ${kofi}
    `)) as unknown as { count: number }[];
    expect(count).toBe(0);

    const again = await groupsService.invite(group.id, ama, [kofi]);
    expect(again).toEqual({ invited: [], skipped: [{ userId: kofi, reason: 'not_found' }] });
  });
});
