import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * A blacklisted account, end to end against a real Postgres: their profile,
 * posts, comments, group membership and follow requests are gone for everyone
 * else, and lifting the blacklist brings it all back.
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
  return { followRequestLimiter: pass, usernameCheckLimiter: pass, groupCreateLimiter: pass, groupInviteLimiter: pass, groupCommentLimiter: pass };
});
const enqueueEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/email-queue', () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification-preferences.service', () => ({
  notificationPreferencesService: { isEnabled: vi.fn().mockResolvedValue(false) },
}));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let authService: typeof import('../services/auth.service').authService;
let customers: typeof import('../services/admin/customers.service').adminCustomersService;
let community: typeof import('../services/community.service').communityService;
let search: typeof import('../services/community-search.service').communitySearchService;
let groupsService: typeof import('../services/groups.service').groupsService;
let groupBooks: typeof import('../services/group-books.service').groupBooksService;
let usersService: typeof import('../services/users.service').usersService;
let assertEmailNotBlacklisted: typeof import('../services/commerce/checkout.service').assertEmailNotBlacklisted;
let server: Server;
let base: string;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'blacklisted-account-test-';
const BOOK_REF = 'blacklisted-account-test-book';
const PASSWORD = 'correct horse battery staple';

describeIfDb('a blacklisted account', () => {
  let ama: number; // blacklisted
  let kofi: number;
  let bookId: number;

  async function cleanUp(): Promise<void> {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  }

  async function user(name: string): Promise<number> {
    const hash = await bcrypt.hash(PASSWORD, 4);
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, username, email, email_verified, shelf_visibility, password_hash)
      VALUES (${name}, ${`bl_${name.toLowerCase()}`}, ${`${EMAIL_PREFIX}${name.toLowerCase()}@example.com`}, true, 'public', ${hash})
      RETURNING id
    `);
    return rows[0].id;
  }

  async function call(caller: number, method: string, path: string) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'x-test-user': String(caller) } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
    try {
      await promise;
      return 'ok';
    } catch (err) {
      return (err as { statusCode?: number }).statusCode ?? 500;
    }
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ authService } = await import('../services/auth.service'));
    ({ adminCustomersService: customers } = await import('../services/admin/customers.service'));
    ({ communityService: community } = await import('../services/community.service'));
    ({ communitySearchService: search } = await import('../services/community-search.service'));
    ({ groupsService } = await import('../services/groups.service'));
    ({ groupBooksService: groupBooks } = await import('../services/group-books.service'));
    ({ usersService } = await import('../services/users.service'));
    ({ assertEmailNotBlacklisted } = await import('../services/commerce/checkout.service'));

    const { default: communityRoutes } = await import('../routes/community.routes');
    const { default: usersRoutes } = await import('../routes/users.routes');
    const { default: groupsRoutes } = await import('../routes/groups.routes');
    const app = express();
    app.use(express.json());
    app.use('/community', communityRoutes);
    app.use('/users', usersRoutes);
    app.use('/groups', groupsRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await cleanUp();
    enqueueEmail.mockClear();
    ama = await user('Ama');
    kofi = await user('Kofi');
    const books = await db.execute<{ id: number }>(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'Beloved') RETURNING id
    `);
    bookId = books[0].id;
  });

  afterAll(async () => {
    server?.close();
    if (db) await cleanUp();
  });

  it('cannot sign in, loses its sessions, is refused by the community, and is emailed', async () => {
    // A live session from before the blacklist.
    const before = await authService.login(`${EMAIL_PREFIX}ama@example.com`, PASSWORD);

    const result = await customers.blacklist(ama, 1, 'test');
    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(1);
    await customers.notifyBlacklisted(result);

    const signIn = await authService.login(`${EMAIL_PREFIX}ama@example.com`, PASSWORD).catch((e) => e);
    expect(signIn).toMatchObject({ statusCode: 403, code: 'ACCOUNT_SUSPENDED' });
    // The session they had cannot be refreshed.
    expect(await status(authService.refresh(before.tokens.refreshToken))).not.toBe('ok');

    // The access token in hand is refused by every community route.
    for (const path of ['/community/posts', `/users/${kofi}`, '/groups']) {
      const res = await call(ama, 'GET', path);
      expect(res.status, path).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_RESTRICTED');
    }
    // Kofi, not blacklisted, is unaffected.
    expect((await call(kofi, 'GET', '/community/posts')).status).toBe(200);

    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledWith('account-blacklisted', { to: `${EMAIL_PREFIX}ama@example.com`, name: 'Ama' });

    // Blacklisting again changes nothing and emails nobody.
    await customers.notifyBlacklisted(await customers.blacklist(ama, 1, 'again'));
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });

  it('disappears for everyone else, and comes back when lifted', async () => {
    const { id: review } = await community.createPost(ama, { bookId, status: 'read', rating: 5, body: 'Loved it', isPublic: true });
    const { id: kofiPost } = await community.createPost(kofi, { bookId, status: 'read', rating: 4, body: 'Good', isPublic: true });
    await community.addComment(kofiPost, ama, 'Agreed');
    const group = await groupsService.create(kofi, { name: 'Blacklist Readers', privacy: 'public' });
    await db.execute(sql`
      INSERT INTO group_memberships (group_id, user_id, status, joined_at) VALUES (${group.id}, ${ama}, 'active', now())
    `);
    const shelf = await groupBooks.setCurrent(group.id, kofi, { bookId, startedOn: '2026-10-01' });
    await groupBooks.addComment(group.id, shelf.id, ama, 'Club comment');

    await customers.blacklist(ama, 1, 'test');

    expect(await status(usersService.getUserProfile(ama, kofi))).toBe(404);
    expect(await status(usersService.getUserBooks(ama, kofi, 'all', 'date_desc' as never, 20, 0))).toBe(404);
    expect(await status(community.getPost(review, kofi))).toBe(404);
    const onBook = await community.listPostsForBook(bookId, kofi, 'date_desc', 20, 0);
    expect(onBook.posts.map((p) => p.id)).toEqual([kofiPost]);
    expect((await community.listComments(kofiPost, kofi, 20, 0)).comments).toHaveLength(0);
    expect((await community.getPost(kofiPost, kofi)).commentCount).toBe(0);
    expect((await search.search('Ama', 'users', kofi, 20, 0)).users).toHaveLength(0);
    expect((await groupsService.listMembers(group.id, kofi, 50, 0)).members.map((m) => m.id)).not.toContain(ama);
    expect((await groupBooks.listComments(group.id, shelf.id, kofi, 20, 0)).comments).toHaveLength(0);
    expect(await status(usersService.sendFollowRequest(kofi, ama))).toBe(404);

    // Lifted: everything is back, as it was.
    await customers.unblacklist(ama);
    expect(await status(usersService.getUserProfile(ama, kofi))).toBe('ok');
    expect(await status(community.getPost(review, kofi))).toBe('ok');
    expect((await community.listComments(kofiPost, kofi, 20, 0)).comments).toHaveLength(1);
    expect((await groupBooks.listComments(group.id, shelf.id, kofi, 20, 0)).comments).toHaveLength(1);
  });

  it('cannot buy as a guest under its own address, in any letter case', async () => {
    const address = `${EMAIL_PREFIX}ama@example.com`;
    expect(await status(assertEmailNotBlacklisted(address))).toBe('ok');

    await customers.blacklist(ama, 1, 'test');
    for (const typed of [address, address.toUpperCase()]) {
      const refused = await assertEmailNotBlacklisted(typed).catch((e) => e);
      expect(refused).toMatchObject({ statusCode: 403, code: 'ACCOUNT_SUSPENDED' });
    }
    // Anyone else's address is unaffected.
    expect(await status(assertEmailNotBlacklisted(`${EMAIL_PREFIX}kofi@example.com`))).toBe('ok');

    await customers.unblacklist(ama);
    expect(await status(assertEmailNotBlacklisted(address))).toBe('ok');
  });

  it('is gone even for someone who had blocked them, who would otherwise see their profile', async () => {
    await db.execute(sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${kofi}, ${ama})`);
    expect(await usersService.getUserProfile(ama, kofi)).toMatchObject({ isBlocked: true });

    await customers.blacklist(ama, 1, 'test');
    expect(await status(usersService.getUserProfile(ama, kofi))).toBe(404);
    expect(await status(usersService.getUserBooks(ama, kofi, 'all', 'date_desc' as never, 20, 0))).toBe(404);
  });

  it('drops its follow requests, and they cannot be accepted', async () => {
    await usersService.sendFollowRequest(ama, kofi);
    const [request] = (await usersService.listPendingFollowRequests(kofi, 20, 0)).items;
    expect(request).toBeDefined();

    await customers.blacklist(ama, 1, 'test');
    expect(await usersService.listPendingFollowRequests(kofi, 20, 0)).toMatchObject({ items: [], total: 0 });
    expect(await status(usersService.acceptFollowRequest(request.id, kofi))).toBe(404);
  });
});
