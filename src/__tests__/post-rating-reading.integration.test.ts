import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * A `reading` post may be unrated; a `read` post may not.
 *
 * WHY THIS EXISTS. Someone halfway through a book has nothing to rate yet, so
 * the rating is optional (null) while the status is `reading` and required
 * once it is `read`. Create checks this on the request alone; edit has to check
 * the post as it will be after the patch, since either field can change on its
 * own. The posts_read_rating_check constraint backs both at the database.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users, and `.env` points at production. Skips itself when unset; refuses to
 * run when it names the same database as `.env`.
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
let communityService: typeof import('../services/community.service').communityService;
let communityController: typeof import('../controllers/community.controller').communityController;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'post-rating-reading-test-';
const BOOK_REF = 'post-rating-reading-test-book';

describeIfDb('community post ratings: optional while reading, required once read', () => {
  let reader: number;
  let bookId: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communityService } = await import('../services/community.service'));
    ({ communityController } = await import('../controllers/community.controller'));

    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'Americanah') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES ('Chidi', ${`${EMAIL_PREFIX}reader@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    reader = row.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  });

  /** Calls a controller handler and returns what it sent. */
  async function call(
    handler: 'createPost' | 'updatePost',
    body: Record<string, unknown>,
    params: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const out = { status: 0, json: undefined as unknown };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(payload: unknown) { out.json = payload; return this; },
    };
    const req = { body, params, user: { id: reader } };
    await communityController[handler](req as never, res as never);
    return out;
  }

  async function stored(postId: number) {
    return communityService.getPost(postId, reader);
  }

  describe('create', () => {
    it('accepts a reading post with no rating, stored as null', async () => {
      const res = await call('createPost', { bookId, status: 'reading', isPublic: true });
      expect(res.status).toBe(201);
      expect(await stored((res.json as { id: number }).id)).toMatchObject({ status: 'reading', rating: null });
    });

    it('accepts a reading post with rating: null', async () => {
      const res = await call('createPost', { bookId, status: 'reading', rating: null, isPublic: true });
      expect(res.status).toBe(201);
    });

    it('still accepts a rated reading post', async () => {
      const res = await call('createPost', { bookId, status: 'reading', rating: 3, isPublic: true });
      expect(res.status).toBe(201);
      expect(await stored((res.json as { id: number }).id)).toMatchObject({ rating: 3 });
    });

    it('refuses a read post with no rating or rating: null', async () => {
      for (const extra of [{}, { rating: null }]) {
        const res = await call('createPost', { bookId, status: 'read', isPublic: true, ...extra });
        expect(res.status).toBe(400);
        expect(res.json).toEqual({ error: { rating: ['A rating is required when status is read'] } });
      }
    });

    it('accepts a rated read post, including 0', async () => {
      const res = await call('createPost', { bookId, status: 'read', rating: 0, isPublic: true });
      expect(res.status).toBe(201);
      expect(await stored((res.json as { id: number }).id)).toMatchObject({ status: 'read', rating: 0 });
    });
  });

  describe('edit', () => {
    async function post(fields: { status: 'reading' | 'read'; rating?: number | null }) {
      return (await communityService.createPost(reader, { bookId, isPublic: true, ...fields })).id;
    }

    async function edit(postId: number, body: Record<string, unknown>) {
      return call('updatePost', body, { postId: String(postId) });
    }

    it('clears the rating on a reading post', async () => {
      const id = await post({ status: 'reading', rating: 4 });
      expect((await edit(id, { rating: null })).status).toBe(200);
      expect(await stored(id)).toMatchObject({ rating: null });
    });

    it('refuses to clear the rating on a read post', async () => {
      const id = await post({ status: 'read', rating: 4 });
      const res = await edit(id, { rating: null });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'A rating is required when status is read' });
      expect(await stored(id)).toMatchObject({ rating: 4 });
    });

    it('refuses to mark an unrated post read without a rating', async () => {
      const id = await post({ status: 'reading' });
      expect((await edit(id, { status: 'read' })).status).toBe(400);
      expect((await edit(id, { status: 'read', rating: null })).status).toBe(400);
      expect(await stored(id)).toMatchObject({ status: 'reading', rating: null });
    });

    it('marks an unrated post read when the rating comes with it', async () => {
      const id = await post({ status: 'reading' });
      expect((await edit(id, { status: 'read', rating: 5 })).status).toBe(200);
      expect(await stored(id)).toMatchObject({ status: 'read', rating: 5 });
    });

    it('marks a rated reading post read on status alone', async () => {
      const id = await post({ status: 'reading', rating: 2 });
      expect((await edit(id, { status: 'read' })).status).toBe(200);
      expect(await stored(id)).toMatchObject({ status: 'read', rating: 2 });
    });

    it('moves a read post back to reading and clears its rating in one edit', async () => {
      const id = await post({ status: 'read', rating: 3 });
      expect((await edit(id, { status: 'reading', rating: null })).status).toBe(200);
      expect(await stored(id)).toMatchObject({ status: 'reading', rating: null });
    });

    it('still 404s on someone else\'s post rather than leaking the rule', async () => {
      const id = await post({ status: 'read', rating: 3 });
      const [other] = (await db.execute(sql`
        INSERT INTO users (name, email, email_verified)
        VALUES ('Ngozi', ${`${EMAIL_PREFIX}other@example.com`}, true)
        RETURNING id
      `)) as unknown as { id: number }[];
      await expect(communityService.updatePost(id, other.id, { rating: null })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it('the database refuses an unrated read post even past the API', async () => {
    await expect(db.execute(sql`
      INSERT INTO posts (user_id, book_id, rating, status, is_public)
      VALUES (${reader}, ${bookId}, NULL, 'read', true)
    `)).rejects.toThrow();
  });
});
