import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

/**
 * The new-book notification never offers a book the reader has already seen,
 * against a real Postgres with pgvector.
 *
 * "Seen" is the shelf (favourites included), the saved list, books removed
 * from either, rejections and books already notified — matched by work, so
 * another edition of any of them is excluded too. Removed books are recorded by
 * database trigger, so whether all of that holds is a property of the schema
 * and the pick running together, which only a real database shows.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite inserts and
 * deletes books. Skips itself when unset; refuses to run when it names the same
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

vi.mock('../lib/email-queue', () => ({ enqueueEmail: vi.fn().mockResolvedValue(undefined), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));

const describeIfDb = testUrl ? describe : describe.skip;
const REF = 'reco-notify-test-';
const ISBN_PREFIX = '979099998';
const EMAIL = 'reco-notify-test-reader@example.com';
const DIMS = 768;

/** The query vector, nudged slightly so each book sits at its own distance. */
function near(by: number): string {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 1;
  v[1] = by;
  return `[${v.join(',')}]`;
}

describeIfDb('new-book notification pick', () => {
  let db: typeof import('../db').db;
  let sql: typeof import('drizzle-orm').sql;
  let svc: typeof import('../services/recommendation-notifications.service');
  let exclusions: typeof import('../lib/exclusions');
  let userId: number;
  const ids = new Map<string, number>();

  // Nearest first. Every "seen" book has a second edition placed just behind
  // the next book, so a pick that only excluded exact IDs would land on it.
  const specs = [
    { key: 'saved', title: 'Saved Novel', author: 'Ama Owusu', by: 0.01 },
    { key: 'saved-pb', title: 'Saved Novel (Paperback)', author: 'Ama Owusu', by: 0.011 },
    { key: 'unsaved', title: 'Saved Then Removed', author: 'Kofi Mensah', by: 0.02 },
    { key: 'unsaved-pb', title: 'The Saved Then Removed', author: 'Kofi Mensah', by: 0.021 },
    { key: 'notified', title: 'Already Sent', author: 'Esi Boateng', by: 0.03 },
    { key: 'notified-pb', title: 'Already Sent: A Novel', author: 'Esi Boateng', by: 0.031 },
    { key: 'liked', title: 'Favourite Book', author: 'Yaw Darko', by: 0.04 },
    { key: 'liked-pb', title: 'Favourite Book (Large Print)', author: 'Yaw Darko', by: 0.041 },
    { key: 'unshelved', title: 'Shelved Then Removed', author: 'Efua Sutherland', by: 0.045 },
    { key: 'unshelved-pb', title: 'Shelved Then Removed: A Novel', author: 'Efua Sutherland', by: 0.046 },
    { key: 'fresh', title: 'Brand New To You', author: 'Abena Asante', by: 0.05 },
    { key: 'fresh-pb', title: 'Brand New To You', author: 'Abena Asante', by: 0.051 },
    { key: 'next', title: 'Second Fresh Pick', author: 'Kwame Nkrumah', by: 0.06 },
  ];

  async function cleanUp() {
    await db.execute(sql`DELETE FROM gardners_stock WHERE isbn13 LIKE ${ISBN_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${REF + '%'}`);
    // Cascades to the reader's shelf, saved books, logs and notifications.
    await db.execute(sql`DELETE FROM users WHERE email = ${EMAIL}`);
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    svc = await import('../services/recommendation-notifications.service');
    exclusions = await import('../lib/exclusions');

    await cleanUp();

    for (const [n, spec] of specs.entries()) {
      const isbn = `${ISBN_PREFIX}${String(n).padStart(4, '0')}`;
      const [row] = (await db.execute(sql`
        INSERT INTO books (record_reference, title, isbn13, publication_date, embedding)
        VALUES (${REF + spec.key}, ${spec.title}, ${isbn}, '2020-01-01', ${near(spec.by)}::vector)
        RETURNING id
      `)) as unknown as { id: number }[];
      ids.set(spec.key, row.id);
      await db.execute(sql`
        INSERT INTO book_contributors (book_id, sequence_number, role, person_name)
        VALUES (${row.id}, 1, 'A01', ${spec.author})
      `);
      await db.execute(sql`
        INSERT INTO gardners_stock (isbn13, book_id, rrp_gbp, stock_qty, source, stock_updated_at)
        VALUES (${isbn}, ${row.id}, 9.99, 5, 'inventory', now())
      `);
    }

    const [user] = (await db.execute(sql`
      INSERT INTO users (name, email, email_verified) VALUES ('Notify Reader', ${EMAIL}, true) RETURNING id
    `)) as unknown as { id: number }[];
    userId = user.id;

    await db.execute(sql`
      INSERT INTO user_preferences (user_id, feelings, book_ids, genres, dislikes, preference_embedding)
      VALUES (${userId}, '[]', '[]', '[]', '{}', ${near(0)}::vector)
    `);
    await db.execute(sql`INSERT INTO notification_preferences (user_id) VALUES (${userId})`);
    // On the lists now: one saved, one favourited.
    await db.execute(sql`INSERT INTO saved_books (user_id, book_id) VALUES (${userId}, ${ids.get('saved')!})`);
    await db.execute(sql`
      INSERT INTO user_books (user_id, book_id, liked) VALUES (${userId}, ${ids.get('liked')!}, true)
    `);
    // Once on the lists, then removed — and removed twice, to show it is
    // remembered once. Only the triggers know about these now.
    for (let i = 0; i < 2; i++) {
      await db.execute(sql`INSERT INTO saved_books (user_id, book_id) VALUES (${userId}, ${ids.get('unsaved')!})`);
      await db.execute(sql`DELETE FROM saved_books WHERE user_id = ${userId} AND book_id = ${ids.get('unsaved')!}`);
    }
    await db.execute(sql`
      INSERT INTO user_books (user_id, book_id, status) VALUES (${userId}, ${ids.get('unshelved')!}, 'read')
    `);
    await db.execute(sql`DELETE FROM user_books WHERE user_id = ${userId} AND book_id = ${ids.get('unshelved')!}`);
    await db.execute(sql`
      INSERT INTO recommendation_email_log (user_id, book_id) VALUES (${userId}, ${ids.get('notified')!})
    `);
    await exclusions.bustUserExclusions(userId);
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  beforeEach(() => vi.clearAllMocks());

  it('skips every seen work, in any edition, and picks the nearest unseen one', async () => {
    const pick = await svc.pickUnsentRecommendation(userId);
    expect(pick?.bookId).toBe(ids.get('fresh'));
  });

  it('remembers each removed book once', async () => {
    const rows = (await db.execute(sql`
      SELECT removed_book_ids FROM user_preferences WHERE user_id = ${userId}
    `)) as unknown as { removed_book_ids: number[] }[];
    expect(rows[0].removed_book_ids).toEqual([ids.get('unsaved')!, ids.get('unshelved')!]);
  });

  it('never notifies another edition of a book it has already notified', async () => {
    expect(await svc.sendRecommendationEmail(userId, EMAIL, 'Notify Reader')).toBe(true);
    const pick = await svc.pickUnsentRecommendation(userId);
    expect(pick?.bookId).toBe(ids.get('next'));
  });
});
