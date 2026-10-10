import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * The personal shelf's five sections, against a real Postgres.
 *
 * WHY THIS EXISTS. Want to read / Reading now / Finished are one column, and
 * Favourites and Owned are flags on top of it. What makes that correct is a
 * rule about rows rather than any one write: an entry stays while it holds
 * anything — a status, either flag, or a note — and goes the moment it holds
 * nothing. That rule is one conditional DELETE, so only a real database shows
 * it keeps and removes the right rows.
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
let userBooksService: typeof import('../services/user-books.service').userBooksService;
let usersService: typeof import('../services/users.service').usersService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'shelf-owned-test-';
const BOOK_REF = 'shelf-owned-test-book';

describeIfDb('shelf sections: one reading status, plus Favourites and Owned', () => {
  let reader: number;
  let bookId: number;

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ userBooksService } = await import('../services/user-books.service'));
    ({ usersService } = await import('../services/users.service'));

    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'Half of a Yellow Sun') RETURNING id
    `)) as unknown as { id: number }[];
    bookId = book.id;
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    const [row] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified)
      VALUES ('Adaeze', ${`${EMAIL_PREFIX}reader@example.com`}, true)
      RETURNING id
    `)) as unknown as { id: number }[];
    reader = row.id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  });

  async function entry() {
    return userBooksService.getStatus(reader, bookId);
  }

  async function sectionIds(filter: { status?: 'want_to_read' | 'reading' | 'read'; liked?: boolean; owned?: boolean }) {
    const { books } = await userBooksService.list({
      userId: reader, sort: 'date_desc', limit: 50, offset: 0, ...filter,
    });
    return books.map((b) => b.bookId);
  }

  it('puts one book in Finished, Favourites and Owned at once', async () => {
    await userBooksService.upsert(reader, bookId, { status: 'read', liked: true, owned: true });

    expect(await entry()).toMatchObject({ status: 'read', liked: true, owned: true });
    expect(await sectionIds({ status: 'read' })).toEqual([bookId]);
    expect(await sectionIds({ liked: true })).toEqual([bookId]);
    expect(await sectionIds({ owned: true })).toEqual([bookId]);
    expect(await sectionIds({ status: 'reading' })).toEqual([]);
    expect(await sectionIds({ status: 'want_to_read' })).toEqual([]);
  });

  it('moves between reading statuses without touching the flags', async () => {
    await userBooksService.upsert(reader, bookId, { status: 'want_to_read', owned: true });
    await userBooksService.upsert(reader, bookId, { status: 'reading' });

    expect(await entry()).toMatchObject({ status: 'reading', liked: false, owned: true });
    expect(await sectionIds({ status: 'want_to_read' })).toEqual([]);
    expect(await sectionIds({ status: 'reading' })).toEqual([bookId]);
  });

  it('clears the status but keeps a book that is still Owned', async () => {
    await userBooksService.upsert(reader, bookId, { status: 'reading', owned: true });
    await userBooksService.upsert(reader, bookId, { status: null });

    expect(await entry()).toMatchObject({ status: null, owned: true });
    expect(await sectionIds({ owned: true })).toEqual([bookId]);
  });

  it('removes the entry when clearing the status leaves nothing', async () => {
    await userBooksService.upsert(reader, bookId, { status: 'reading' });
    await userBooksService.upsert(reader, bookId, { status: null });

    expect(await entry()).toBeNull();
  });

  it('does not create an empty entry from status: null on a book not on the shelf', async () => {
    await userBooksService.upsert(reader, bookId, { status: null });
    expect(await entry()).toBeNull();
  });

  it('own creates an entry with no status, and unown removes it', async () => {
    await userBooksService.own(reader, bookId);
    expect(await entry()).toMatchObject({ status: null, liked: false, owned: true });

    await userBooksService.unown(reader, bookId);
    expect(await entry()).toBeNull();
  });

  it('keeps the first owned date when Owned is set again', async () => {
    await userBooksService.own(reader, bookId);
    const before = (await userBooksService.list({ userId: reader, sort: 'date_desc', limit: 1, offset: 0 })).books[0].ownedAt;

    await userBooksService.own(reader, bookId);
    await userBooksService.upsert(reader, bookId, { owned: true });
    const after = (await userBooksService.list({ userId: reader, sort: 'date_desc', limit: 1, offset: 0 })).books[0].ownedAt;

    expect(before).not.toBeNull();
    expect(after?.getTime()).toBe(before?.getTime());
  });

  it('unown keeps a book that has a reading status or is a Favourite', async () => {
    await userBooksService.upsert(reader, bookId, { status: 'want_to_read', owned: true });
    await userBooksService.unown(reader, bookId);
    expect(await entry()).toMatchObject({ status: 'want_to_read', owned: false });

    await userBooksService.remove(reader, bookId);
    await userBooksService.like(reader, bookId);
    await userBooksService.own(reader, bookId);
    await userBooksService.unown(reader, bookId);
    expect(await entry()).toMatchObject({ status: null, liked: true, owned: false });
  });

  it('unlike keeps a book that is still Owned', async () => {
    await userBooksService.like(reader, bookId);
    await userBooksService.own(reader, bookId);
    await userBooksService.unlike(reader, bookId);

    expect(await entry()).toMatchObject({ status: null, liked: false, owned: true });
  });

  it('unlike no longer throws away a note on a book with no status', async () => {
    await userBooksService.upsert(reader, bookId, { liked: true, note: 'Read this for Mum' });
    await userBooksService.unlike(reader, bookId);

    expect(await entry()).toMatchObject({ liked: false, note: 'Read this for Mum' });
  });

  it('removes the entry when the last flag goes and there is no note', async () => {
    await userBooksService.like(reader, bookId);
    await userBooksService.unlike(reader, bookId);
    expect(await entry()).toBeNull();
  });

  it('keeps a quiz pick\'s source when it is favourited or owned', async () => {
    await db.execute(sql`
      INSERT INTO user_books (user_id, book_id, status, source) VALUES (${reader}, ${bookId}, 'want_to_read', 'chosen_from_quiz')
    `);
    await userBooksService.own(reader, bookId);
    await userBooksService.like(reader, bookId);
    await userBooksService.upsert(reader, bookId, { owned: true, liked: true });

    const [row] = (await db.execute(sql`
      SELECT source FROM user_books WHERE user_id = ${reader} AND book_id = ${bookId}
    `)) as unknown as { source: string }[];
    expect(row.source).toBe('chosen_from_quiz');
  });

  it('keeps the first liked date when Favourites is set again', async () => {
    await userBooksService.like(reader, bookId);
    const likedAt = async () =>
      (await userBooksService.list({ userId: reader, sort: 'date_desc', limit: 1, offset: 0 })).books[0].likedAt;
    const before = await likedAt();

    await userBooksService.like(reader, bookId);
    await userBooksService.upsert(reader, bookId, { liked: true });

    expect(before).not.toBeNull();
    expect((await likedAt())?.getTime()).toBe(before?.getTime());
  });

  it('saves a whitespace-only note as no note, so it cannot keep an empty entry', async () => {
    await userBooksService.upsert(reader, bookId, { owned: true, note: '  \n\t ' });
    expect(await entry()).toMatchObject({ owned: true, note: null });

    await userBooksService.unown(reader, bookId);
    expect(await entry()).toBeNull();
  });

  it('treats a stored note of Unicode whitespace as empty when pruning', async () => {
    // Rows written before notes were trimmed: a newline and a non-breaking space.
    await db.execute(sql`
      INSERT INTO user_books (user_id, book_id, owned, note) VALUES (${reader}, ${bookId}, true, ${'\n\u00a0'})
    `);
    await userBooksService.unown(reader, bookId);
    expect(await entry()).toBeNull();
  });

  it('shows Favourites and Owned as sections of a public shelf', async () => {
    await userBooksService.upsert(reader, bookId, { status: 'read', liked: true, owned: true });

    const owned = await usersService.getUserBooks(reader, reader, 'owned', 'date_desc', 20, 0);
    const liked = await usersService.getUserBooks(reader, reader, 'liked', 'date_desc', 20, 0);
    const reading = await usersService.getUserBooks(reader, reader, 'reading', 'date_desc', 20, 0);

    expect(owned.items).toEqual([expect.objectContaining({ bookId, status: 'read', liked: true, owned: true })]);
    expect(liked.total).toBe(1);
    expect(reading.total).toBe(0);
  });
});
