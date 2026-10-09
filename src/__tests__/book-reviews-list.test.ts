import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * GET /books/:id/reviews — everyone's reviews of a book, the caller's own
 * pinned first. The database is mocked: what matters is the WHERE (whose
 * private reviews may appear) and the ORDER BY (that the pin is part of the
 * query, so pagination never shows it twice), rendered to SQL.
 */

// Each db.select() call takes the next result off this queue, in call order:
// the book existence check, the page, the count, then enrichPosts' likes,
// comments and my-likes. An empty queue answers "book exists" by default.
let results: unknown[][] = [];
const BOOK = [{ id: 5 }];
const wheres: SQL[] = [];
const orderBys: SQL[][] = [];

function chain(result: unknown[]) {
  const q: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'groupBy', 'limit', 'offset']) q[m] = () => q;
  q.where = (cond: SQL) => {
    wheres.push(cond);
    return q;
  };
  q.orderBy = (...cols: SQL[]) => {
    orderBys.push(cols);
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

vi.mock('../db', () => ({
  db: { select: () => chain(results.shift() ?? []) },
}));
vi.mock('../services/book-excerpts.service', () => ({
  getExcerptsByIsbns: async () => new Map(),
  pickExcerpt: () => null,
}));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn() }));
vi.mock('../services/notification-preferences.service', () => ({
  notificationPreferencesService: { isEnabled: vi.fn() },
}));

import { communityService } from '../services/community.service';

const dialect = new PgDialect();
const createdAt = new Date('2026-10-01T00:00:00Z');
const row = (id: number, userId: number, isPublic = true) => ({
  id,
  userId,
  userName: `user ${userId}`,
  userPhotoUrl: null,
  bookId: 5,
  bookTitle: 'A Book',
  bookCoverUrl: null,
  bookIsbn13: '9780000000000',
  rating: 4,
  status: 'read',
  body: null,
  isPublic,
  createdAt,
  updatedAt: createdAt,
});

beforeEach(() => {
  results = [BOOK];
  wheres.length = 0;
  orderBys.length = 0;
});

describe('listReviewsForBook', () => {
  it("shows public reviews and the caller's own, never anyone else's private one", async () => {
    await communityService.listReviewsForBook(5, 7, 'date_desc', 20, 0);

    const { sql, params } = dialect.sqlToQuery(wheres[1]);
    expect(sql).toBe('("posts"."book_id" = $1 and ("posts"."is_public" = $2 or "posts"."user_id" = $3))');
    expect(params).toEqual([5, true, 7]);
    // The count uses the same filter, so total matches what pages return.
    expect(dialect.sqlToQuery(wheres[2]).sql).toBe(sql);
  });

  it("pins the caller's review first in the query itself, then sorts by date", async () => {
    await communityService.listReviewsForBook(5, 7, 'date_asc', 20, 0);

    const rendered = orderBys[0].map((c) => dialect.sqlToQuery(c));
    expect(rendered[0].sql).toBe('"posts"."user_id" = $1 desc');
    expect(rendered[0].params).toEqual([7]);
    expect(rendered.slice(1).map((r) => r.sql)).toEqual(['"posts"."created_at" asc', '"posts"."id" asc']);
  });

  it('keeps the pin when sorting newest first', async () => {
    await communityService.listReviewsForBook(5, 7, 'date_desc', 20, 0);

    const rendered = orderBys[0].map((c) => dialect.sqlToQuery(c).sql);
    expect(rendered).toEqual(['"posts"."user_id" = $1 desc', '"posts"."created_at" desc', '"posts"."id" desc']);
  });

  it("flags only the caller's review as isMine", async () => {
    results = [BOOK, [row(70, 7, false), row(80, 8), row(90, 9)], [{ count: 3 }]];
    const { posts, total } = await communityService.listReviewsForBook(5, 7, 'date_desc', 20, 0);

    expect(posts.map((p) => [p.id, p.isMine])).toEqual([[70, true], [80, false], [90, false]]);
    expect(total).toBe(3);
    expect(posts[0]).not.toHaveProperty('bookIsbn13');
  });

  it('returns an empty page for a book nobody has reviewed', async () => {
    results = [BOOK, [], [{ count: 0 }]];
    expect(await communityService.listReviewsForBook(5, 7, 'date_desc', 20, 0)).toEqual({ posts: [], total: 0 });
  });

  it('throws a 404 for a book that does not exist', async () => {
    results = [[], [], [{ count: 0 }]];
    await expect(communityService.listReviewsForBook(999, 7, 'date_desc', 20, 0)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Book not found',
    });
    expect(dialect.sqlToQuery(wheres[0])).toMatchObject({ sql: '"books"."id" = $1', params: [999] });
  });
});
