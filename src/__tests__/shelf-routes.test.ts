import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /user-books — the HTTP layer over userBooksService (whose rules are pinned
 * against a real database in shelf-owned.integration.test.ts). Driven through
 * the real route stack, so these cover what the service tests can't: which
 * routes need Plus, the clear-only PUT that doesn't, and request validation.
 */

const { service, requirePlus } = vi.hoisted(() => ({
  service: {
    list: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
    like: vi.fn(),
    unlike: vi.fn(),
    own: vi.fn(),
    unown: vi.fn(),
    resetLibrary: vi.fn(),
  },
  // Stands in for a lapsed member: the gate always refuses.
  requirePlus: vi.fn((_req: unknown, res: { status(c: number): { json(b: unknown): unknown } }) => {
    res.status(402).json({ code: 'PLUS_REQUIRED' });
  }),
}));

vi.mock('../services/user-books.service', () => ({ userBooksService: service }));
vi.mock('../services/my-reviews.service', () => ({ withMyReviews: vi.fn(async (_u: number, books: unknown[]) => books) }));
vi.mock('../middleware/require-plus.middleware', () => ({ requirePlus }));
vi.mock('../middleware/auth.middleware', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import userBooksRoutes from '../routes/user-books.routes';

type Handler = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Handler }[] } };

function route(method: string, path: string) {
  const layer = (userBooksRoutes as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer?.route) throw new Error(`no ${method.toUpperCase()} ${path}`);
  return layer.route;
}

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

/** Runs a route's handlers in order, as Express would, stopping when one doesn't call next. */
async function call(method: string, path: string, req: { params?: object; body?: unknown; query?: object }) {
  const res = fakeRes();
  const fullReq = { params: { bookId: '48213' }, query: {}, user: { id: 7 }, ...req };
  for (const { handle } of route(method, path).stack) {
    let advanced = false;
    await handle(fullReq, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(service)) fn.mockResolvedValue(undefined);
  service.list.mockResolvedValue({ books: [], total: 0 });
});

describe('PUT /user-books/:bookId for a member without Plus', () => {
  it.each([
    [{ status: null }],
    [{ owned: false }],
    [{ liked: false, owned: false }],
    [{ note: null, noteIsPublic: false }],
    [{ note: '   ' }],
  ])('lets a clear-only body through: %j', async (body) => {
    const res = await call('put', '/:bookId', { body });
    expect(requirePlus).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(service.upsert).toHaveBeenCalledWith(7, 48213, body);
  });

  it.each([
    [{ status: 'read' }],
    [{ owned: true }],
    [{ status: null, owned: true }],
    [{ note: 'Lend to Ama' }],
    [{}],
    [{ constructor: 1 }],
  ])('sends anything that adds, or is not a known clear, to the Plus gate: %j', async (body) => {
    const res = await call('put', '/:bookId', { body });
    expect(requirePlus).toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(service.upsert).not.toHaveBeenCalled();
  });
});

describe('own / unown routes', () => {
  it('needs Plus to mark a book Owned', async () => {
    const res = await call('post', '/:bookId/own', {});
    expect(res.statusCode).toBe(402);
    expect(service.own).not.toHaveBeenCalled();
  });

  it('lets anyone un-mark a book as Owned', async () => {
    const res = await call('delete', '/:bookId/own', {});
    expect(res.statusCode).toBe(200);
    expect(service.unown).toHaveBeenCalledWith(7, 48213);
  });

  it('passes a service 404 through', async () => {
    requirePlus.mockImplementationOnce((_req, _res, next?: () => void) => next?.());
    service.own.mockRejectedValueOnce(Object.assign(new Error('Book not found'), { statusCode: 404 }));
    const res = await call('post', '/:bookId/own', {});
    expect(res.statusCode).toBe(404);
  });

  it('rejects a non-numeric book id', async () => {
    const res = await call('delete', '/:bookId/own', { params: { bookId: 'abc' } });
    expect(res.statusCode).toBe(400);
    expect(service.unown).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('accepts owned on its own as the one required field', async () => {
    requirePlus.mockImplementationOnce((_req, _res, next?: () => void) => next?.());
    const res = await call('put', '/:bookId', { body: { owned: true } });
    expect(res.statusCode).toBe(200);
    expect(service.upsert).toHaveBeenCalledWith(7, 48213, { owned: true });
  });

  it('parses ?owned=true into the Owned filter', async () => {
    await call('get', '/', { query: { owned: 'true' } });
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, owned: true }));
  });
});
