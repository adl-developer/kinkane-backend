import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * Who can read someone's shelf, against a real Postgres.
 *
 * WHY THIS EXISTS. A shelf is readable through three doors — the full shelf
 * (GET /users/:userId/books), one book off it (GET /community/users/:friendId/
 * books/:bookId), and the `canViewShelf` flag on the profile that tells the app
 * whether to show the tab at all. The full shelf and the flag apply
 * canViewShelf; the one-book door applies canViewShelfBook, which also always
 * lets accepted followers in (both in users.service.ts). Both depend on the
 * follow graph, so only real rows show the doors behave. The one-book door also
 * carries the owner's review, which has a privacy setting of its own: a public
 * shelf must not be a way to read a private review.
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
let usersService: typeof import('../services/users.service').usersService;
let communityService: typeof import('../services/community.service').communityService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'shelf-visibility-test-';
const BOOK_REF = 'shelf-visibility-test-book';
const OTHER_BOOK_REF = 'shelf-visibility-test-other-book';

type Visibility = 'public' | 'friends' | 'private';

describeIfDb('shelf visibility: full shelf, one book, and the profile flag', () => {
  let bookId: number;
  let otherBookId: number;
  let owner: number;
  let follower: number;
  let requester: number;
  let stranger: number;

  async function createUser(name: string): Promise<number> {
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES (${name}, ${`${EMAIL_PREFIX}${name.toLowerCase()}@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    return row.id;
  }

  async function follow(sender: number, receiver: number, status: 'pending' | 'accepted'): Promise<void> {
    await db.execute(sql`
      INSERT INTO follow_requests (sender_id, receiver_id, status) VALUES (${sender}, ${receiver}, ${status})
    `);
  }

  async function setVisibility(visibility: Visibility): Promise<void> {
    await db.execute(sql`UPDATE users SET shelf_visibility = ${visibility} WHERE id = ${owner}`);
  }

  async function review(isPublic: boolean): Promise<void> {
    await db.execute(sql`
      INSERT INTO posts (user_id, book_id, rating, status, body, is_public)
      VALUES (${owner}, ${bookId}, 4, 'read', 'Kept me up all night', ${isPublic})
    `);
  }

  /** The HTTP status each door would answer with: 200, or the error's statusCode. */
  async function statusOf(call: () => Promise<unknown>): Promise<number> {
    try {
      await call();
      return 200;
    } catch (err) {
      return (err as { statusCode?: number }).statusCode ?? 500;
    }
  }

  const fullShelf = (viewer: number) =>
    statusOf(() => usersService.getUserBooks(owner, viewer, 'all', 'date_desc', 20, 0));
  const oneBook = (viewer: number, book = bookId) =>
    statusOf(() => communityService.getFriendBookDetail(owner, book, viewer));
  const flag = async (viewer: number) => (await usersService.getUserProfile(owner, viewer)).canViewShelf;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ usersService } = await import('../services/users.service'));
    ({ communityService } = await import('../services/community.service'));

    await db.execute(sql`DELETE FROM books WHERE record_reference IN (${BOOK_REF}, ${OTHER_BOOK_REF})`);
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title, isbn13) VALUES (${BOOK_REF}, 'Homegoing', '9781111111112') RETURNING id
    `)) as unknown as { id: number }[];
    const [other] = (await db.execute(sql`
      INSERT INTO books (record_reference, title, isbn13) VALUES (${OTHER_BOOK_REF}, 'Ghana Must Go', '9781111111113') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
    otherBookId = other.id;
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    owner = await createUser('Ama');
    follower = await createUser('Kofi');
    requester = await createUser('Esi');
    stranger = await createUser('Yaw');
    await follow(follower, owner, 'accepted');
    await follow(requester, owner, 'pending');
    await db.execute(sql`INSERT INTO user_books (user_id, book_id, status) VALUES (${owner}, ${bookId}, 'read')`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference IN (${BOOK_REF}, ${OTHER_BOOK_REF})`);
  });

  it('opens a public shelf to everyone, follower or not', async () => {
    await setVisibility('public');
    for (const viewer of [follower, requester, stranger]) {
      expect(await fullShelf(viewer)).toBe(200);
      expect(await oneBook(viewer)).toBe(200);
      expect(await flag(viewer)).toBe(true);
    }
  });

  it('opens a friends-only shelf to accepted followers, not to a pending request or a stranger', async () => {
    await setVisibility('friends');
    expect(await fullShelf(follower)).toBe(200);
    expect(await oneBook(follower)).toBe(200);
    expect(await flag(follower)).toBe(true);

    for (const viewer of [requester, stranger]) {
      expect(await fullShelf(viewer)).toBe(404);
      expect(await oneBook(viewer)).toBe(404);
      expect(await flag(viewer)).toBe(false);
    }
  });

  it('closes a private shelf to everyone else, accepted followers included', async () => {
    await setVisibility('private');
    for (const viewer of [follower, requester, stranger]) {
      expect(await fullShelf(viewer)).toBe(404);
      expect(await flag(viewer)).toBe(false);
    }
  });

  it('still opens one book off a private shelf to accepted followers, and nobody else', async () => {
    await setVisibility('private');
    expect(await oneBook(follower)).toBe(200);
    expect(await oneBook(requester)).toBe(404);
    expect(await oneBook(stranger)).toBe(404);
  });

  it('always opens your own shelf, private included', async () => {
    await setVisibility('private');
    expect(await fullShelf(owner)).toBe(200);
    expect(await oneBook(owner)).toBe(200);
  });

  it('answers a hidden shelf exactly like a missing account', async () => {
    await setVisibility('private');
    // Each call is started inside its own expect. Starting both up front left
    // the second rejecting while the first was still awaited, which Vitest
    // reports as an unhandled rejection and fails the run on.
    await expect(communityService.getFriendBookDetail(owner, bookId, stranger))
      .rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
    await expect(communityService.getFriendBookDetail(2_000_000_000, bookId, stranger))
      .rejects.toMatchObject({ statusCode: 404, message: 'User not found' });
  });

  it('still 404s a book that is not on a visible shelf', async () => {
    await setVisibility('public');
    expect(await oneBook(stranger, otherBookId)).toBe(404);
  });

  describe('the review on one book', () => {
    it('shows a public review to anyone who can see the shelf', async () => {
      await setVisibility('public');
      await review(true);
      const detail = await communityService.getFriendBookDetail(owner, bookId, stranger);
      expect(detail).toMatchObject({ rating: 4, review: 'Kept me up all night' });
    });

    it('hides a private review from strangers on a public shelf', async () => {
      await setVisibility('public');
      await review(false);
      const detail = await communityService.getFriendBookDetail(owner, bookId, stranger);
      expect(detail).toMatchObject({ rating: null, review: null });
    });

    it('hides a private review from accepted followers too — private posts are author-only', async () => {
      // Private shelf: the follower gets the book page, but still not the review
      await setVisibility('private');
      await review(false);
      const detail = await communityService.getFriendBookDetail(owner, bookId, follower);
      expect(detail).toMatchObject({ rating: null, review: null });
    });

    it('shows a private review to its author', async () => {
      await setVisibility('private');
      await review(false);
      const detail = await communityService.getFriendBookDetail(owner, bookId, owner);
      expect(detail).toMatchObject({ rating: 4, review: 'Kept me up all night' });
    });
  });
});
