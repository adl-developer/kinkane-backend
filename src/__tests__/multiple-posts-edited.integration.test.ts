import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * A reader can post about a book more than once, and edits are marked.
 *
 * WHY THIS EXISTS. Posting "reading" and later "finished" used to fail with a
 * 409 (one post per reader per book), so the app edited the first post and the
 * reading update vanished from the feed. Now each is its own post; the book
 * card's myReview and the friend's-book page show the latest. Separately, the
 * app shows "Edited" on a post or comment whose text, rating or status changed
 * — but not on a visibility switch or a resend of the same text, which is why
 * edits are tracked in edited_at rather than read off updated_at.
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
let getMyReview: typeof import('../services/my-reviews.service').getMyReview;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'multi-post-edited-test-';
const BOOK_REF = 'multi-post-edited-test-book';

describeIfDb('several posts per book, and edit markers', () => {
  let reader: number;
  let bookId: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ communityService } = await import('../services/community.service'));
    ({ communityController } = await import('../controllers/community.controller'));
    ({ getMyReview } = await import('../services/my-reviews.service'));

    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'Homegoing') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES ('Efua', ${`${EMAIL_PREFIX}reader@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    reader = row.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  });

  async function call(
    handler: 'createPost' | 'updatePost' | 'updateComment',
    body: Record<string, unknown>,
    params: Record<string, string> = {},
  ): Promise<{ status: number; json: any }> {
    const out = { status: 0, json: undefined as any };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(payload: unknown) { out.json = payload; return this; },
    };
    await communityController[handler]({ body, params, user: { id: reader } } as never, res as never);
    return out;
  }

  const post = async (fields: { status: 'reading' | 'read'; rating?: number | null; body?: string }) =>
    (await communityService.createPost(reader, { bookId, isPublic: true, ...fields })).id;

  // Distinct created_at so "latest" is unambiguous without relying on the id tiebreak.
  const backdate = (postId: number, minutesAgo: number) =>
    db.execute(sql`UPDATE posts SET created_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${postId}`);

  describe('several posts about one book', () => {
    it('keeps a reading post and a finished post as two posts, both listed', async () => {
      const first = await call('createPost', { bookId, status: 'reading', body: 'Fifty pages in.', isPublic: true });
      const second = await call('createPost', { bookId, status: 'read', rating: 5, body: 'Finished. Wow.', isPublic: true });
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.json.id).not.toBe(first.json.id);

      const mine = await communityService.listOwnPosts(reader, 'date_asc', 20, 0);
      expect(mine.total).toBe(2);
      expect(mine.posts.map((p) => p.body)).toEqual(['Fifty pages in.', 'Finished. Wow.']);

      const forBook = await communityService.listReviewsForBook(bookId, reader, 'date_desc', 20, 0);
      expect(forBook.total).toBe(2);
    });

    it('shows the newest post as myReview', async () => {
      const reading = await post({ status: 'reading', body: 'Fifty pages in.' });
      const read = await post({ status: 'read', rating: 4, body: 'Finished.' });
      await backdate(reading, 60);
      await backdate(read, 5);
      expect(await getMyReview(reader, bookId)).toMatchObject({ postId: read, status: 'read', rating: 4 });

      // Newest wins even when it has the lower id.
      await backdate(reading, 1);
      expect(await getMyReview(reader, bookId)).toMatchObject({ postId: reading, status: 'reading' });
    });

    it('friend page: rating and review both come from the latest post', async () => {
      await db.execute(sql`INSERT INTO user_books (user_id, book_id, status) VALUES (${reader}, ${bookId}, 'reading')`);
      const read = await post({ status: 'read', rating: 2, body: 'Not for me.' });
      const reread = await post({ status: 'reading', body: 'Rereading, loving it.' });
      await backdate(read, 60);
      await backdate(reread, 5);

      // Never "2 stars — rereading, loving it": an old rating is not paired
      // with newer words. The latest post is unrated, so no rating.
      let detail = await communityService.getFriendBookDetail(reader, bookId, reader);
      expect(detail).toMatchObject({ review: 'Rereading, loving it.', rating: null, reviewIsEdited: false });

      const finished = await post({ status: 'read', rating: 5, body: 'Changed my mind.' });
      await backdate(finished, 1);
      detail = await communityService.getFriendBookDetail(reader, bookId, reader);
      expect(detail).toMatchObject({ review: 'Changed my mind.', rating: 5 });
    });
  });

  describe('repeat submissions', () => {
    const create = (body: Record<string, unknown>) => call('createPost', { bookId, isPublic: true, ...body });

    it('an identical post moments later returns the first, with 200', async () => {
      const first = await create({ status: 'reading', body: 'Fifty pages in.' });
      const again = await create({ status: 'reading', body: 'Fifty pages in.' });
      expect(first.status).toBe(201);
      expect(again).toEqual({ status: 200, json: { id: first.json.id } });
      expect((await communityService.listOwnPosts(reader, 'date_desc', 20, 0)).total).toBe(1);
    });

    it('two simultaneous identical submits make one post', async () => {
      const results = await Promise.all([1, 2, 3].map(() => create({ status: 'read', rating: 4, body: 'Done.' })));
      expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect((await communityService.listOwnPosts(reader, 'date_desc', 20, 0)).total).toBe(1);
    });

    it('anything different is a new post', async () => {
      const base = { status: 'reading', rating: 3, body: 'Hmm.' };
      const ids = new Set<number>();
      for (const variant of [base, { ...base, body: 'Hmm!' }, { ...base, rating: 4 }, { ...base, status: 'read' }]) {
        const res = await create(variant);
        expect(res.status).toBe(201);
        ids.add(res.json.id);
      }
      expect(ids.size).toBe(4);
    });

    it('the same words again after the window are a new post', async () => {
      const first = await create({ status: 'reading', body: 'Still going.' });
      await backdate(first.json.id, 10);
      const later = await create({ status: 'reading', body: 'Still going.' });
      expect(later.status).toBe(201);
      expect(later.json.id).not.toBe(first.json.id);
    });
  });

  describe('edit markers on posts', () => {
    const edit = (postId: number, body: Record<string, unknown>) =>
      call('updatePost', body, { postId: String(postId) });

    it('a new post is not edited', async () => {
      const id = await post({ status: 'reading', body: 'Started.' });
      expect(await communityService.getPost(id, reader)).toMatchObject({ isEdited: false, editedAt: null });
    });

    it('changing the body marks it edited, and the response says so', async () => {
      const id = await post({ status: 'reading', body: 'Started.' });
      const res = await edit(id, { body: 'Started, loving it.' });
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      expect(res.json.post).toMatchObject({ id, body: 'Started, loving it.', isEdited: true });
      expect(res.json.post.editedAt).toBeInstanceOf(Date);

      // And everywhere else the post appears.
      expect((await communityService.listOwnPosts(reader, 'date_desc', 20, 0)).posts[0].isEdited).toBe(true);
      expect(await getMyReview(reader, bookId)).toMatchObject({ isEdited: true });
    });

    it('changing the rating or status marks it edited', async () => {
      // Distinct bodies: identical posts in a row would be folded into one.
      const a = await post({ status: 'reading', rating: 3, body: 'a' });
      expect((await edit(a, { rating: 4 })).json.post.isEdited).toBe(true);
      const b = await post({ status: 'reading', rating: 3, body: 'b' });
      expect((await edit(b, { status: 'read' })).json.post.isEdited).toBe(true);
      const c = await post({ status: 'reading', rating: 3, body: 'c' });
      expect((await edit(c, { rating: null })).json.post.isEdited).toBe(true);
    });

    it('editedAt and updatedAt come from the same clock', async () => {
      const id = await post({ status: 'reading', body: 'Started.' });
      const res = await edit(id, { body: 'Started again.' });
      expect(res.json.post.editedAt).toEqual(res.json.post.updatedAt);
    });

    it('a handle that has since become a user does not make resent text an edit', async () => {
      const handle = 'mpe_newcomer';
      await db.execute(sql`DELETE FROM users WHERE username = ${handle}`);
      const id = await post({ status: 'reading', body: `Lending this to @${handle} next.` });

      // The handle named nobody when posted; now it does.
      await db.execute(sql`
        INSERT INTO users (name, email, email_verified, username)
        VALUES ('Newcomer', ${`${EMAIL_PREFIX}newcomer@example.com`}, true, ${handle})
      `);

      const res = await edit(id, { body: `Lending this to @${handle} next.`, isPublic: false });
      expect(res.json.post).toMatchObject({ isEdited: false, editedAt: null, mentions: [] });
      const [stored] = (await db.execute(sql`SELECT body FROM posts WHERE id = ${id}`)) as unknown as { body: string }[];
      expect(stored.body).toBe(`Lending this to @${handle} next.`);
      await db.execute(sql`DELETE FROM users WHERE username = ${handle}`);
    });

    it('a visibility switch alone is not an edit', async () => {
      const id = await post({ status: 'reading', body: 'Started.' });
      const res = await edit(id, { isPublic: false });
      expect(res.json.post).toMatchObject({ isPublic: false, isEdited: false, editedAt: null });
    });

    it('resending identical values is not an edit', async () => {
      const id = await post({ status: 'read', rating: 4, body: 'Great.' });
      const res = await edit(id, { body: 'Great.', rating: 4, status: 'read' });
      expect(res.json.post).toMatchObject({ isEdited: false, editedAt: null });
    });

    it('a later no-op patch keeps the earlier edit time', async () => {
      const id = await post({ status: 'reading', body: 'Started.' });
      const first = (await edit(id, { body: 'Started!' })).json.post.editedAt as Date;
      const after = (await edit(id, { isPublic: false })).json.post;
      expect(after.isEdited).toBe(true);
      expect(after.editedAt).toEqual(first);
    });

    it('the friend page carries the review\'s edit state', async () => {
      await db.execute(sql`INSERT INTO user_books (user_id, book_id, status) VALUES (${reader}, ${bookId}, 'read')`);
      const id = await post({ status: 'read', rating: 5, body: 'Good.' });
      await edit(id, { body: 'Very good.' });
      const detail = await communityService.getFriendBookDetail(reader, bookId, reader);
      expect(detail.reviewIsEdited).toBe(true);
      expect(detail.reviewEditedAt).toBeInstanceOf(Date);
    });
  });

  describe('edit markers on comments', () => {
    it('marks a comment edited only when its text changes', async () => {
      const postId = await post({ status: 'reading' });
      const { id } = await communityService.addComment(postId, reader, 'Same here.');

      let page = await communityService.listComments(postId, reader, 20, 0);
      expect(page.comments[0]).toMatchObject({ isEdited: false, editedAt: null });

      const same = await call('updateComment', { body: 'Same here.' }, { commentId: String(id) });
      expect(same.status).toBe(200);
      expect(same.json.comment).toMatchObject({ id, isEdited: false, editedAt: null });

      const changed = await call('updateComment', { body: 'Same here — chapter 3 got me.' }, { commentId: String(id) });
      expect(changed.json.comment).toMatchObject({ id, body: 'Same here — chapter 3 got me.', isEdited: true });

      page = await communityService.listComments(postId, reader, 20, 0);
      expect(page.comments[0].isEdited).toBe(true);
      expect(page.comments[0].editedAt).toBeInstanceOf(Date);
    });
  });
});
