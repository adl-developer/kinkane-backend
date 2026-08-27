import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The `type` parameter belongs to v2 and only to v2.
 *
 * Two contracts are pinned here, and both are negative ones:
 *
 * - `GET /api/v2/books?q=` searches one side of the catalogue, never both. There is no
 *   combined mode. A client that sends `type=all` — the value the sibling typeahead
 *   endpoint still accepts, and the value v1 behaves as — must be told so, rather than
 *   quietly served a title search it did not ask for and cannot detect.
 * - `GET /api/v1/books` does not take `type` at all, and rejects it rather than ignoring
 *   it. Ignoring would leave a client that had adopted `type` getting blended pages with
 *   no signal that its parameter does nothing; the failure would surface as an author
 *   search returning title matches, which reads as a ranking bug rather than a wrong URL.
 *
 * The positive half — that v1 never sets `searchType` and so lands on the blended path —
 * is asserted too, because that absence is what booksService.list keys the whole v1
 * behaviour (and its cache entries) on.
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
import booksV2Routes from '../routes/books.v2.routes';

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

const callV1 = async (query: Record<string, unknown>) => {
  const res = fakeRes();
  await booksController.list({ query, headers: {} } as never, res as never);
  return res;
};

const callV2 = async (query: Record<string, unknown>) => {
  const res = fakeRes();
  await booksController.listV2({ query, headers: {} } as never, res as never);
  return res;
};

beforeEach(() => {
  listSpy.mockClear();
});

describe('the type flag on GET /api/v2/books', () => {
  it('defaults to a title search when the caller says nothing', async () => {
    const res = await callV2({ q: 'hunt' });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'title' });
  });

  it('passes an explicit author search through', async () => {
    const res = await callV2({ q: 'hunt', type: 'author' });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'author' });
  });

  it('passes an explicit title search through', async () => {
    await callV2({ q: 'hunt', type: 'title' });
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'title' });
  });

  it('rejects the combined mode rather than silently picking a side', async () => {
    // `all` is not merely unsupported — it is what v1 does, and what the typeahead still
    // does. A client carrying it over from either would otherwise get a title-only page
    // under a name it read as "both".
    const res = await callV2({ q: 'hunt', type: 'all' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown side', async () => {
    const res = await callV2({ q: 'hunt', type: 'publisher' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('is accepted without q, where it simply has nothing to act on', async () => {
    // Not an error: a filter-only browse matches nothing textual, so the flag is inert
    // rather than contradictory. Rejecting it would break a UI that keeps one query-string
    // builder for both the browse and the search.
    const res = await callV2({ genre: 'literary-fiction', type: 'author' });
    expect(res.statusCode).toBe(200);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ searchType: 'author' });
    expect(listSpy.mock.calls[0]![0]).not.toHaveProperty('q');
  });
});

describe('GET /api/v1/books does not take type', () => {
  it('searches without a side, which is what selects the blended path', async () => {
    const res = await callV1({ q: 'hunt' });
    expect(res.statusCode).toBe(200);
    // Absent, not 'title'. booksService.list reads a missing searchType as "search both
    // sides and merge", and JSON.stringify omits an absent key — which is also what keeps
    // v1's cache entries separate from v2's for the same query.
    expect(listSpy.mock.calls[0]![0]).not.toHaveProperty('searchType');
  });

  it('rejects type=author rather than ignoring it', async () => {
    const res = await callV1({ q: 'hunt', type: 'author' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('rejects type=title too, even though v1 would not have blended anything else in', async () => {
    // Tempting to wave this one through on the grounds that it is nearly what v1 does
    // anyway — but it is not: v1 still folds in author matches. Accepting the parameter
    // here would mean accepting it and disobeying it, on the one value where the
    // difference is hardest for a client to notice.
    const res = await callV1({ q: 'hunt', type: 'title' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('names v2 in the error, so the fix is the URL rather than the parameter', async () => {
    const res = await callV1({ q: 'hunt', type: 'author' });
    const message = (res.body as { error: { type: string[] } }).error.type[0];
    expect(message).toContain('/api/v2/books');
  });

  it('rejects type on a filter-only browse as well', async () => {
    // v2 accepts an inert type here. v1 has no version of the parameter to be inert
    // about, so "you are on the wrong endpoint" is true whether or not there is a q.
    const res = await callV1({ genre: 'literary-fiction', type: 'author' });
    expect(res.statusCode).toBe(400);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('leaves every other parameter working exactly as it does on v2', async () => {
    // The two versions share one handler body, so this is really a check that the split
    // did not accidentally narrow v1's schema along with its search behaviour.
    const query = { q: 'hunt', genre: 'literary-fiction', limit: '5', offset: '10', sortBy: 'newest' };
    const v1 = await callV1(query);
    const v1Opts = listSpy.mock.calls[0]![0];
    listSpy.mockClear();
    const v2 = await callV2(query);
    const v2Opts = listSpy.mock.calls[0]![0];

    expect(v1.statusCode).toBe(200);
    expect(v2.statusCode).toBe(200);
    expect({ ...v1Opts, searchType: undefined }).toEqual({ ...v2Opts, searchType: undefined });
  });
});

describe('what /api/v2 actually exposes', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
  const routes = (booksV2Routes as unknown as { stack: Layer[] }).stack
    .filter((l): l is Required<Layer> => Boolean(l.route));

  it('mounts the list endpoint and nothing else', () => {
    // The versioning decision, asserted rather than described in a comment: only the one
    // endpoint that differs is versioned. A v2 twin of /books/search or /books/{id} would
    // behave identically to its v1 original, so it would be a second URL to keep in step
    // for no benefit — and the first divergence between them would be an accident.
    expect(routes.map((l) => [Object.keys(l.route.methods), l.route.path])).toEqual([
      [['get'], '/'],
    ]);
  });

  it('routes it to the handler that takes type, not the frozen one', () => {
    // Wiring v1's handler here would leave `/api/v2/books?type=author` returning blended
    // pages *and* rejecting the parameter — the exact failure the split exists to prevent,
    // and invisible to every other test in this file, which calls the handlers directly.
    expect(routes[0]!.route.stack.at(-1)!.handle).toBe(booksController.listV2);
  });
});
