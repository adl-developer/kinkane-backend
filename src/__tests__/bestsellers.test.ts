import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Guards on the bestseller chart.
 *
 * Three things here are the kind of bug that passes every other test: a cache
 * invalidator whose prefix does not match the keys it is meant to clear (it
 * scanned `v1` while the writer had moved to `v2`, so the nightly job cleared
 * nothing and logged success for months); a `shoppable` flag documented in the
 * OpenAPI spec but never parsed, so the promised shop fields were silently
 * absent; and a trending fallback that must be distinguishable from a real
 * sales ranking, because the whole objection to having one is that a discovery
 * feed under a Bestsellers heading is a lie about the shop.
 *
 * None of those change a status code, and two of them look correct in a log.
 */

const dialect = new PgDialect();

// ── db ────────────────────────────────────────────────────────────────────────
// The ranking aggregate is the only query this service runs directly; rows come
// from `rankRows` and the compiled WHERE lands in `lastWhere` so the shoppable
// predicate can be asserted on rather than assumed.
let rankRows: { bookId: number; copiesSold: number }[] = [];
let lastWhere = '';
let lastLimit = -1;
let lastOrderBy = '';

function render(part: unknown): string {
  try {
    return dialect.sqlToQuery(part as never).sql;
  } catch {
    return '';
  }
}

function selectChain(): unknown {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: (condition: unknown) => {
      lastWhere = render(condition);
      return chain;
    },
    groupBy: () => chain,
    orderBy: (part: unknown) => {
      lastOrderBy = render(part);
      return chain;
    },
    limit: (n: number) => {
      lastLimit = n;
      return chain;
    },
    then: (resolve: (rows: unknown[]) => unknown) => resolve(rankRows),
  };
  return chain;
}

vi.mock('../db', () => ({
  db: { select: () => selectChain() },
}));

// ── redis ─────────────────────────────────────────────────────────────────────
// A real enough store that cache keys are observable and `invalidate` has
// something to fail to match.
let store = new Map<string, string>();

vi.mock('../lib/redis', () => ({
  redis: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    keys: async (pattern: string) => {
      const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return [...store.keys()].filter((k) => re.test(k));
    },
    del: async (...keys: string[]) => {
      for (const key of keys) store.delete(key);
      return keys.length;
    },
  },
}));

vi.mock('../lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// attachShopFields reaches for live prices; nothing here is about what a price
// says, only about whether the shop fields were asked for at all.
vi.mock('../services/commerce/availability.service', () => ({
  availabilityService: {
    livePricesByIsbns: async () => new Map(),
    inStockByIsbns: async () => new Map(),
  },
}));

// vi.mock is hoisted above these imports, so the service picks up the mocks.
import { bestsellersService } from '../services/commerce/bestsellers.service';
import { booksService } from '../services/books.service';

/** A catalogue row in the shape listByIds returns. */
function book(id: number) {
  return { id, isbn13: `978${id.toString().padStart(10, '0')}`, title: `Book ${id}` };
}

beforeEach(() => {
  rankRows = [];
  lastWhere = '';
  lastLimit = -1;
  lastOrderBy = '';
  store = new Map();
  vi.restoreAllMocks();
  // Hydration is a shared serializer with its own coverage; here it only has to
  // return something id-shaped so ordering and source can be asserted.
  vi.spyOn(booksService, 'listByIds').mockImplementation(
    async (ids: number[]) => ids.map(book) as never,
  );
  vi.spyOn(booksService, 'trending').mockResolvedValue([]);
});

describe('rank', () => {
  it('counts copies rather than money', async () => {
    // Summing revenue would rank a book differently depending on which currency
    // its buyers happened to be in.
    rankRows = [{ bookId: 1, copiesSold: 9 }];
    await bestsellersService.rank('30d', 10);

    expect(lastOrderBy).toContain('sum');
    expect(lastOrderBy).not.toMatch(/price|amount|total/i);
  });

  it('tie-breaks on book id so equal-selling books hold a stable order', async () => {
    // Without it the chart reshuffles on every cache refresh, which reads as a
    // ranking change to anyone watching it.
    await bestsellersService.rank('30d', 10);

    expect(lastOrderBy).toMatch(/desc/i);
    expect(lastOrderBy.toLowerCase().indexOf('asc')).toBeGreaterThan(
      lastOrderBy.toLowerCase().indexOf('desc'),
    );
  });

  it('numbers ranks from one, in the order the query returned', async () => {
    rankRows = [
      { bookId: 7, copiesSold: 40 },
      { bookId: 3, copiesSold: 12 },
    ];

    expect(await bestsellersService.rank('7d', 10)).toEqual([
      { bookId: 7, copiesSold: 40, rank: 1 },
      { bookId: 3, copiesSold: 12, rank: 2 },
    ]);
  });

  it('bounds an all_time chart by nothing but the sold statuses', async () => {
    await bestsellersService.rank('all_time', 10);
    // A windowed chart adds a created_at bound; all_time must not.
    expect(lastWhere).not.toContain('created_at');
  });

  it('bounds a windowed chart by created_at', async () => {
    await bestsellersService.rank('90d', 10);
    expect(lastWhere).toContain('created_at');
  });
});

describe('rank with shoppable', () => {
  it('applies the shoppable predicate inside the ranking query', async () => {
    // The point of it being *inside* the query: filtering after the LIMIT is how
    // a top 10 comes back holding three.
    await bestsellersService.rank('30d', 10, true);

    expect(lastWhere).toContain('gardners_stock');
    expect(lastLimit).toBe(10);
  });

  it('leaves the chart unfiltered when the caller did not ask to shop', async () => {
    await bestsellersService.rank('30d', 10);
    expect(lastWhere).not.toContain('gardners_stock');
  });

  it('needs no over-fetch pool, because the predicate and the limit are one statement', async () => {
    // Every other feed widens its pool to survive post-filtering. This one must
    // not have to: `limit` shoppable books come back as `limit` shoppable books.
    await bestsellersService.rank('30d', 20, true);
    expect(lastLimit).toBe(20);
  });
});

describe('list', () => {
  it('reports source "orders" when books have actually sold', async () => {
    rankRows = [{ bookId: 4, copiesSold: 3 }];

    const result = await bestsellersService.list('30d', 10);

    expect(result.source).toBe('orders');
    expect(result.books.map((b) => b.id)).toEqual([4]);
  });

  it('preserves rank order through hydration', async () => {
    // listByIds makes no ordering promise — an IN (...) lookup comes back in
    // whatever order the planner likes, which would silently scramble a chart.
    rankRows = [
      { bookId: 9, copiesSold: 30 },
      { bookId: 2, copiesSold: 20 },
      { bookId: 5, copiesSold: 10 },
    ];
    vi.spyOn(booksService, 'listByIds').mockImplementation(
      async (ids: number[]) => [...ids].reverse().map(book) as never,
    );

    const result = await bestsellersService.list('30d', 10);

    expect(result.books.map((b) => b.id)).toEqual([9, 2, 5]);
  });

  it('drops an id hydration could not resolve rather than emitting a hole', async () => {
    rankRows = [
      { bookId: 1, copiesSold: 5 },
      { bookId: 404, copiesSold: 4 },
    ];
    vi.spyOn(booksService, 'listByIds').mockImplementation(
      async (ids: number[]) => ids.filter((id) => id !== 404).map(book) as never,
    );

    const result = await bestsellersService.list('30d', 10);

    expect(result.books.map((b) => b.id)).toEqual([1]);
    expect(result.books).not.toContain(undefined);
  });
});

describe('list falling back to trending', () => {
  it('reports source "trending" when nothing sold in the window', async () => {
    // The fallback is only defensible because it is declared. A client keys its
    // section heading off this field; if it ever silently said "orders" the
    // endpoint would be presenting a discovery feed as a sales chart.
    rankRows = [];
    vi.spyOn(booksService, 'trending').mockResolvedValue([{ id: 11 }] as never);

    const result = await bestsellersService.list('30d', 10);

    expect(result.source).toBe('trending');
    expect(result.books.map((b) => b.id)).toEqual([11]);
  });

  it('returns the same book shape from either source', async () => {
    // One rail, one card component. `trending` yields a narrower row than the
    // chart does, so the fallback re-hydrates rather than returning it raw —
    // otherwise the card loses fields the moment the shop stops selling.
    rankRows = [{ bookId: 11, copiesSold: 2 }];
    const sold = await bestsellersService.list('30d', 10);

    store.clear();
    rankRows = [];
    vi.spyOn(booksService, 'trending').mockResolvedValue([{ id: 11 }] as never);
    const fallback = await bestsellersService.list('30d', 10);

    expect(Object.keys(fallback.books[0]).sort()).toEqual(Object.keys(sold.books[0]).sort());
  });

  it('stays unpersonalised, so one response describes every caller', async () => {
    // A bestseller ranking is factual and identical for everyone. The fallback
    // must not quietly become a personalised feed the moment the shop runs dry.
    rankRows = [];
    const trending = vi.spyOn(booksService, 'trending').mockResolvedValue([]);

    await bestsellersService.list('30d', 10);

    // The second argument is the one that matters: a userId here would filter
    // the fallback per viewer and quietly make one caller's chart differ from
    // another's. Currency is deliberately absent too — attachShopFields applies
    // it afterwards, and passing it here as well would price the list twice.
    const [limit, userId] = trending.mock.calls[0];
    expect(limit).toBe(10);
    expect(userId).toBeUndefined();
    expect(trending.mock.calls[0]).toHaveLength(3);
  });

  it('carries shoppable into the fallback', async () => {
    // A rail that asked for sellable books needs them just as much when the
    // answer comes from trending — it has the same Add button either way.
    rankRows = [];
    const trending = vi.spyOn(booksService, 'trending').mockResolvedValue([]);

    await bestsellersService.list('30d', 10, true, 'NGN');

    expect(trending).toHaveBeenCalledWith(10, undefined, true);
  });

  it('still returns an empty list when there is no interaction data either', async () => {
    rankRows = [];
    vi.spyOn(booksService, 'trending').mockResolvedValue([]);

    const result = await bestsellersService.list('30d', 10);

    expect(result.books).toEqual([]);
    expect(result.source).toBe('trending');
  });
});

describe('caching', () => {
  it('caches the empty ranking, so an unsold shop does not re-aggregate forever', async () => {
    rankRows = [];
    await bestsellersService.list('30d', 10);

    expect([...store.values()]).toContain('[]');
  });

  it('reaches the fallback from a cached empty ranking without re-aggregating', async () => {
    rankRows = [];
    await bestsellersService.list('30d', 10);

    const trending = vi.spyOn(booksService, 'trending').mockResolvedValue([{ id: 3 }] as never);
    lastWhere = '';
    const result = await bestsellersService.list('30d', 10);

    expect(result.source).toBe('trending');
    expect(trending).toHaveBeenCalled();
    // A cache hit must not have run the aggregate again.
    expect(lastWhere).toBe('');
  });

  it('keeps the shoppable and unfiltered charts in separate keys', async () => {
    // They are different lists. Sharing a key let whichever ran first serve the
    // other for an hour — a shoppable rail rendering unsellable books.
    rankRows = [{ bookId: 1, copiesSold: 1 }];
    await bestsellersService.list('30d', 10);
    await bestsellersService.list('30d', 10, true);

    expect(store.size).toBe(2);
  });

  it('keys each window and limit separately', async () => {
    rankRows = [{ bookId: 1, copiesSold: 1 }];
    await bestsellersService.list('7d', 10);
    await bestsellersService.list('30d', 10);
    await bestsellersService.list('30d', 5);

    expect(store.size).toBe(3);
  });

  it('caches ids only, never a price', async () => {
    // A cached price is a wrong price: supplier prices move hourly and the shop
    // rests on a displayed price being the one the basket honours.
    rankRows = [{ bookId: 1, copiesSold: 1 }];
    await bestsellersService.list('30d', 10, true, 'GBP');

    for (const value of store.values()) {
      expect(JSON.parse(value)).toEqual([1]);
    }
  });
});

describe('invalidate', () => {
  it('actually clears the keys list writes', async () => {
    // The regression this exists for: it scanned `bestsellers:v1:*` while
    // cacheKey wrote `v2`, so it matched nothing, cleared nothing, and the
    // nightly job logged "Bestseller cache invalidated" over a full cache.
    rankRows = [{ bookId: 1, copiesSold: 1 }];
    await bestsellersService.list('30d', 10);
    await bestsellersService.list('7d', 10, true);
    expect(store.size).toBeGreaterThan(0);

    await bestsellersService.invalidate();

    expect(store.size).toBe(0);
  });

  it('leaves other services\' caches alone', async () => {
    rankRows = [{ bookId: 1, copiesSold: 1 }];
    await bestsellersService.list('30d', 10);
    store.set('trending:v4:10:all', '[]');

    await bestsellersService.invalidate();

    expect([...store.keys()]).toEqual(['trending:v4:10:all']);
  });

  it('recomputes on the next request rather than serving the dropped entry', async () => {
    rankRows = [{ bookId: 1, copiesSold: 1 }];
    await bestsellersService.list('30d', 10);
    await bestsellersService.invalidate();

    rankRows = [{ bookId: 2, copiesSold: 8 }];
    const result = await bestsellersService.list('30d', 10);

    expect(result.books.map((b) => b.id)).toEqual([2]);
  });
});
