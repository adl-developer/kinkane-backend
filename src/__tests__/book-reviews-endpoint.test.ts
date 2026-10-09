import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * GET /books/:id/reviews — the HTTP layer over listReviewsForBook (whose SQL
 * is pinned in book-reviews-list.test.ts). Driven through the real route
 * stack, so these also cover the wiring: sign-in is required, the handler is
 * wrapped so a service 404 becomes a 404, and an unexpected error reaches the
 * global handler instead of being echoed to the client.
 */

const { listReviews, requireAuth } = vi.hoisted(() => ({
  listReviews: vi.fn(),
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../services/community.service', () => ({ communityService: { listReviewsForBook: listReviews } }));
vi.mock('../services/community-search.service', () => ({ communitySearchService: {} }));
vi.mock('../services/books.service', () => ({ booksService: {}, decodeDedupeCursor: () => null }));
vi.mock('../services/user-books.service', () => ({ userBooksService: {} }));
vi.mock('../services/interactions.service', () => ({ interactionsService: {} }));
vi.mock('../services/my-reviews.service', () => ({ withMyReviews: vi.fn(), getMyReview: vi.fn() }));
vi.mock('../middleware/auth.middleware', () => ({
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth,
}));
vi.mock('../config', () => ({ config: { commerce: { cart: { maxItems: 50 } } } }));
vi.mock('../services/commerce/pricing', () => ({}));
vi.mock('../services/commerce/gardners-regions', () => ({}));
vi.mock('../lib/money', () => ({}));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import booksRoutes from '../routes/books.routes';

type Handler = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } };

const reviewsRoute = (booksRoutes as unknown as { stack: Layer[] }).stack.find(
  (l) => l.route?.path === '/:id/reviews' && l.route.methods.get,
)!.route!;

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

// Runs the handler the way Express would after requireAuth has let the request through.
async function call(id: string, query: Record<string, string> = {}) {
  const res = fakeRes();
  const next = vi.fn();
  const handler = reviewsRoute.stack[reviewsRoute.stack.length - 1].handle;
  await handler({ params: { id }, query, user: { id: 7 } }, res, next);
  // wrapHttp's catch runs on a later tick.
  await new Promise((r) => setImmediate(r));
  return { res, next };
}

const review = (id: number, isMine = false) => ({ id, userId: isMine ? 7 : id, isMine });

beforeEach(() => {
  listReviews.mockReset();
  listReviews.mockResolvedValue({ posts: [], total: 0 });
});

describe('the route', () => {
  it('requires sign-in before the handler runs', () => {
    const handles = reviewsRoute.stack.map((l) => l.handle);
    expect(handles).toHaveLength(2);
    expect(handles[0]).toBe(requireAuth);
  });
});

describe('validation', () => {
  it('rejects a non-numeric book id', async () => {
    const { res } = await call('abc');
    expect(res.statusCode).toBe(400);
    expect(listReviews).not.toHaveBeenCalled();
  });

  it.each([
    [{ offset: '10001' }],
    [{ offset: '-1' }],
    [{ limit: '51' }],
    [{ sort: 'rating' }],
  ])('rejects %o', async (query) => {
    const { res } = await call('5', query);
    expect(res.statusCode).toBe(400);
    expect(listReviews).not.toHaveBeenCalled();
  });

  it('accepts the deepest allowed offset', async () => {
    const { res } = await call('5', { offset: '10000' });
    expect(res.statusCode).toBe(200);
  });
});

describe('a page of reviews', () => {
  it('passes the caller and defaults to the service', async () => {
    await call('5');
    expect(listReviews).toHaveBeenCalledWith(5, 7, 'date_desc', 20, 0);
  });

  it('returns the page with hasMore when more reviews follow', async () => {
    listReviews.mockResolvedValue({ posts: [review(1, true), review(2)], total: 5 });
    const { res } = await call('5', { limit: '2', offset: '0', sort: 'date_asc' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      reviews: [review(1, true), review(2)],
      total: 5,
      sort: 'date_asc',
      limit: 2,
      offset: 0,
      hasMore: true,
    });
  });

  it('reports no more on the last page', async () => {
    listReviews.mockResolvedValue({ posts: [review(5)], total: 5 });
    const { res } = await call('5', { limit: '2', offset: '4' });
    expect((res.body as { hasMore: boolean }).hasMore).toBe(false);
  });
});

describe('errors', () => {
  it('turns the service 404 for an unknown book into a 404', async () => {
    listReviews.mockRejectedValue(Object.assign(new Error('Book not found'), { statusCode: 404 }));
    const { res, next } = await call('999');

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'Book not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('hands an unexpected error to the global handler without echoing it', async () => {
    const err = new Error('relation "posts" does not exist');
    listReviews.mockRejectedValue(err);
    const { res, next } = await call('5');

    expect(next).toHaveBeenCalledWith(err);
    expect(res.body).toBeUndefined();
  });
});
