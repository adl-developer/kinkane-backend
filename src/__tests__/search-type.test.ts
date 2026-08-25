import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `GET /books?q=` searches one side of the catalogue, never both.
 *
 * The contract worth pinning is the negative one: there is no combined mode. A client
 * that sends `type=all` — the value the sibling typeahead endpoint still accepts, and the
 * value this endpoint used to behave as — must be told so, rather than quietly served a
 * title search it did not ask for and cannot detect.
 */

// vi.hoisted, because vi.mock is lifted above ordinary top-level declarations.
const { listSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(async (_opts: Record<string, unknown>) => ({
    books: [],
    total: 0,
    hasMore: false,
    totalIsApproximate: false,
    nextCursor: null,
  })),
}));

vi.mock('../services/books.service', () => ({
  booksService: { list: listSpy },
  decodeDedupeCursor: () => null,
}));
vi.mock('../services/user-books.service', () => ({ userBooksService: {} }));
vi.mock('../services/interactions.service', () => ({ interactionsService: {} }));
vi.mock('../config', () => ({ config: { commerce: { cart: { maxItems: 50 } } } }));
vi.mock('../services/commerce/pricing', () => ({
  fromPresentment: (v: number) => v,
  resolveCurrency: () => 'GBP',
  resolveRequestCountry: async () => 'GB',
}));
vi.mock('../lib/money', () => ({ minorUnitsPerMajor: () => 100 }));

import { booksController } from '../controllers/books.controller';

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

const call = async (query: Record<string, unknown>) => {
  const res = fakeRes();
  await booksController.list({ query, headers: {} } as never, res as never);
  return res;
};

beforeEach(() => {
  listSpy.mockClear();
});

describe('the type flag on GET /books', () => {
  it('defaults to a title search when the caller says nothing', async () => {
    const res = await call({ q: 'hunt' });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'title' });
  });

  it('passes an explicit author search through', async () => {
    const res = await call({ q: 'hunt', type: 'author' });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'author' });
  });

  it('passes an explicit title search through', async () => {
    await call({ q: 'hunt', type: 'title' });
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'title' });
  });

  it('rejects the combined mode rather than silently picking a side', async () => {
    // `all` is not merely unsupported — it is the behaviour this endpoint used to have,
    // and the one the typeahead still has. A client carrying it over from either would
    // otherwise get a title-only page under a name it read as "both".
    const res = await call({ q: 'hunt', type: 'all' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown side', async () => {
    const res = await call({ q: 'hunt', type: 'publisher' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('is accepted without q, where it simply has nothing to act on', async () => {
    // Not an error: a filter-only browse matches nothing textual, so the flag is inert
    // rather than contradictory. Rejecting it would break a UI that keeps one query-string
    // builder for both the browse and the search.
    const res = await call({ genre: 'literary-fiction', type: 'author' });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'author' });
    expect(listSpy.mock.calls[0]![0]).not.toHaveProperty('q');
  });
});
