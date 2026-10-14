import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql as sqlTag, type SQL } from 'drizzle-orm';

/**
 * Every book a signed-in reader is shown carries `myReview` — their own
 * rating and review (community post) of that book, or null. The database is
 * mocked: what matters is which ids are asked for and how rows map back.
 */

let rows: Record<string, unknown>[] = [];
let failWith: Error | null = null;
const select = vi.fn();
// The WHERE condition of the last query, kept so tests can render it to SQL.
// Asserting on the rows alone would pass even if the query stopped filtering
// by reader — the mock hands back whatever rows the test set up.
let lastWhere: SQL | undefined;
// DISTINCT ON columns and ORDER BY of the last query: together they decide
// which of several posts about one book becomes myReview.
let lastDistinctOn: unknown[] = [];
let lastOrderBy: unknown[] = [];
const warn = vi.fn();

vi.mock('../db', () => ({
  db: {
    selectDistinctOn: (on: unknown[], ...a: unknown[]) => {
      lastDistinctOn = on;
      select(...a);
      return {
        from: () => ({
          where: (cond: SQL) => {
            lastWhere = cond;
            return {
              orderBy: async (...order: unknown[]) => {
                lastOrderBy = order;
                if (failWith) throw failWith;
                return rows;
              },
            };
          },
        }),
      };
    },
  },
}));

vi.mock('../lib/logger', () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), error: vi.fn() } }));

const dialect = new PgDialect();

import { withMyReviews, getMyReview } from '../services/my-reviews.service';

const createdAt = new Date('2026-10-01T00:00:00Z');
const post = (bookId: number, rating: number) => ({
  bookId,
  postId: bookId * 10,
  rating,
  status: 'read',
  body: `review of ${bookId}`,
  isPublic: false,
  createdAt,
  updatedAt: createdAt,
  editedAt: null as Date | null,
});

beforeEach(() => {
  rows = [];
  failWith = null;
  lastWhere = undefined;
  select.mockClear();
  warn.mockClear();
});

describe('the reviews query', () => {
  it("reads only the caller's own posts, for only the books on the page", async () => {
    await withMyReviews(7, [{ id: 11 }, { id: 12 }, { id: 11 }], (b) => b.id);

    // Without the user_id condition every reader's reviews of these books would
    // come back, and the first one found would be shown as the caller's own.
    const { sql, params } = dialect.sqlToQuery(lastWhere!);
    expect(sql).toContain('"posts"."user_id" = $1');
    expect(sql).toContain('"posts"."book_id" in ($2, $3)');
    expect(params).toEqual([7, 11, 12]);
  });

  it('keeps one post per book, the newest', async () => {
    // A reader can post about a book while reading and again when finished;
    // the card shows the later one. DISTINCT ON keeps the first row per book
    // in ORDER BY order, so the order must lead with book_id, then newest.
    await withMyReviews(7, [{ id: 11 }], (b) => b.id);

    const render = (parts: unknown[]) =>
      dialect.sqlToQuery(sqlTag.join(parts as SQL[], sqlTag`, `)).sql;
    expect(render(lastDistinctOn)).toBe('"posts"."book_id"');
    expect(render(lastOrderBy)).toBe('"posts"."book_id", "posts"."created_at" desc, "posts"."id" desc');
  });
});

describe('edit state', () => {
  it('marks a review edited only when editedAt is set', async () => {
    const editedAt = new Date('2026-10-02T00:00:00Z');
    rows = [post(1, 4), { ...post(2, 3), editedAt }];
    const result = await withMyReviews(7, [{ id: 1 }, { id: 2 }], (b) => b.id);
    expect(result.map((r) => [r.myReview?.isEdited, r.myReview?.editedAt])).toEqual([
      [false, null],
      [true, editedAt],
    ]);
  });
});

describe('withMyReviews', () => {
  it('attaches the matching review to each book and null to the rest', async () => {
    rows = [post(2, 4)];
    const result = await withMyReviews(7, [{ id: 1 }, { id: 2 }], (b) => b.id);

    expect(result[0].myReview).toBeNull();
    expect(result[1].myReview).toEqual({
      postId: 20,
      rating: 4,
      status: 'read',
      body: 'review of 2',
      // No @mentions or addresses in this body, so nothing to link and no lookup made.
      mentions: [],
      links: [],
      isPublic: false,
      createdAt,
      updatedAt: createdAt,
      isEdited: false,
      editedAt: null,
    });
    // bookId is the join key, not part of the review shape.
    expect(result[1].myReview).not.toHaveProperty('bookId');
  });

  it('gives a signed-out caller null everywhere without touching the database', async () => {
    const result = await withMyReviews(undefined, [{ id: 1 }], (b) => b.id);
    expect(result).toEqual([{ id: 1, myReview: null }]);
    expect(select).not.toHaveBeenCalled();
  });

  it('skips the query for an empty list', async () => {
    expect(await withMyReviews(7, [], (b: { id: number }) => b.id)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps every other field and the original order', async () => {
    rows = [post(1, 5)];
    const result = await withMyReviews(7, [{ bookId: 3, t: 'c' }, { bookId: 1, t: 'a' }], (b) => b.bookId);
    expect(result.map((r) => [r.t, r.myReview?.rating ?? null])).toEqual([
      ['c', null],
      ['a', 5],
    ]);
  });
});

describe('when the lookup fails', () => {
  it('returns the books with null reviews instead of throwing', async () => {
    failWith = new Error('connection terminated');
    const result = await withMyReviews(7, [{ id: 1 }], (b) => b.id);

    expect(result).toEqual([{ id: 1, myReview: null }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives the book page a null review instead of throwing', async () => {
    failWith = new Error('timeout');
    expect(await getMyReview(7, 1)).toBeNull();
  });
});

describe('getMyReview', () => {
  it('returns null when signed out or never reviewed', async () => {
    expect(await getMyReview(undefined, 1)).toBeNull();
    expect(await getMyReview(7, 1)).toBeNull();
  });

  it('returns the review when there is one', async () => {
    rows = [post(1, 3)];
    expect((await getMyReview(7, 1))?.rating).toBe(3);
  });
});
