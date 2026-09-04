import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * What a shop page costs before it returns a row.
 *
 * `GET /books?shoppable=true` is ranked, not filtered, and the ranking is a ladder of
 * bands walked in order (see SHOP_BAND). Mapping a page offset onto that ladder needs the
 * band *sizes*, and each size is a correlated EXISTS over `gardners_stock` per candidate
 * row whose LIMIT only short-circuits once a band exceeds SHOP_BAND_COUNT_CAP — a band
 * smaller than the cap scans the whole catalogue to discover it. Cold, the pair measured
 * at 42s on production against a 2M-row catalogue, on the request path, so the first
 * shopper after each COUNT_TTL lapse paid for both.
 *
 * The same is true of the total: a filter-only browse used to run an unbounded exact
 * COUNT(*) over that catalogue, measured at 5.5s cold, and now asks the planner whether
 * counting is affordable first (see EXACT_COUNT_MAX_ROWS).
 *
 * No guard here changes a single returned row, which is exactly why they need pinning: a
 * regression is invisible in the response and shows up only as latency.
 */

const dialect = new PgDialect();

let issued: string[] = [];
let explains: string[] = [];
let redisReads: string[] = [];
let cacheWrites: [string, string][] = [];
let counts: number[] = [];
// What the planner claims the filtered scan will return. null stages an unreadable plan.
let planRows: number | null = 0;
// What the exact COUNT(*) comes back with, and how many times it was actually run.
let exactCount = 0;
let exactCountRuns = 0;
// Staged Postgres statement_timeout abort against the exact count.
let countError: unknown = null;
let cachedCount: string | null = null;

function render(query: unknown): string {
  try {
    return dialect.sqlToQuery(query as never).sql;
  } catch {
    return String(query);
  }
}

function execute(query: unknown): Promise<unknown[]> {
  const text = render(query);
  if (/^\s*SET\b/i.test(text)) return Promise.resolve([]);
  // EXPLAIN is the planner probe, not a query the guards below are counting.
  if (/^\s*EXPLAIN/i.test(text)) {
    explains.push(text);
    return Promise.resolve([
      { 'QUERY PLAN': planRows == null ? 'not a plan' : [{ Plan: { 'Plan Rows': planRows } }] },
    ]);
  }
  issued.push(text);
  return Promise.resolve([{ count: counts.shift() ?? 0 }]);
}

let selectWheres: string[] = [];

// `db.select({ count })` is uniquely the exact total — the band counts go through
// db.execute, and every row fetch projects real columns — so the projection is enough to
// tell them apart and to stage a count row for one without affecting the other.
function selectChain(projection?: unknown): unknown {
  const isCount =
    typeof projection === 'object' && projection !== null && 'count' in projection;
  if (isCount) exactCountRuns += 1;
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (w: unknown) => {
      if (w !== undefined) selectWheres.push(render(w));
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
      if (isCount && countError) return reject?.(countError);
      return resolve(isCount ? [{ count: exactCount }] : []);
    },
  };
  return chain;
}

vi.mock('../db', () => ({
  db: {
    execute,
    select: (p?: unknown) => selectChain(p),
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({ execute, select: (p?: unknown) => selectChain(p) }),
  },
}));

vi.mock('../lib/redis', () => ({
  redis: {
    get: async (key: string) => {
      redisReads.push(key);
      return key.startsWith('books:count:') ? cachedCount : null;
    },
    set: async (key: string, value: string) => {
      cacheWrites.push([key, value]);
      return 'OK';
    },
    del: async () => 1,
  },
}));

vi.mock('../lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { booksService } from '../services/books.service';

// No `q`: a filter-only shop browse, which is the path the band ladder serves and the one
// that carried the 42s. A search reaches the bands through the tier probes instead.
const browse = (o: Record<string, unknown> = {}) =>
  booksService.list({ limit: 40, offset: 0, dedupe: false, shoppable: true, ...o } as never);

/** countUpTo's shape — the only db.execute COUNT a no-`q` browse can issue. */
const isBandCount = (sql: string) => /COUNT\(\*\)/i.test(sql) && /LIMIT/i.test(sql);

const keyOfKind = (kind: string, keys: string[]) => keys.filter((k) => k.startsWith(kind));

beforeEach(() => {
  issued = [];
  redisReads = [];
  cacheWrites = [];
  counts = [];
  selectWheres = [];
  explains = [];
  planRows = 0;
  exactCount = 0;
  exactCountRuns = 0;
  countError = null;
  cachedCount = null;
});

describe('shop band counts', () => {
  it('are not computed for the first page', async () => {
    await browse({ offset: 0 });
    expect(issued.filter(isBandCount)).toEqual([]);
    expect(keyOfKind('books:shopband:', redisReads)).toEqual([]);
  });

  // The reason skipping them is safe: the ladder is walked from band 0 regardless, and
  // the loop tops up from the next band whenever one returns short. It reaches the same
  // rows without being told where the boundaries are.
  it('still walk the ladder from band 0 when skipped', async () => {
    await browse({ offset: 0 });
    // Three band-predicated row fetches, in band order, because the mock returns no rows
    // and each band is topped up from the next.
    const banded = selectWheres.filter((w) => /gardners_stock/i.test(w));
    expect(banded.length).toBe(3);
    expect(/stock_qty/i.test(banded[0]!)).toBe(true);
  });

  // A deep page genuinely has bands to skip, so the sizes are load-bearing there and must
  // still be paid for.
  it('are computed once the page runs past the first band', async () => {
    counts = [500, 500];
    await browse({ offset: 5000 });
    expect(issued.filter(isBandCount).length).toBe(2);
    expect(keyOfKind('books:shopband:', redisReads).length).toBe(2);
  });
});

describe('the count cache key', () => {
  // `currency` never reaches a WHERE clause — the price bounds arrive already converted to
  // GBP pence — so it cannot change any count. It used to ride into the key anyway, and
  // because the controller resolves it from the visitor's *country*, every new country
  // paid a fresh 42s cold count for three identical numbers.
  it('ignores currency, which cannot change a count', async () => {
    await browse({ currency: 'GBP' });
    const gbp = keyOfKind('books:count:', redisReads);
    redisReads = [];
    await browse({ currency: 'EUR' });
    expect(keyOfKind('books:count:', redisReads)).toEqual(gbp);
  });

  it('ignores currency for the band keys too, which share the same filters', async () => {
    counts = [500, 500];
    await browse({ offset: 5000, currency: 'GBP' });
    const gbp = keyOfKind('books:shopband:', redisReads);
    redisReads = [];
    counts = [500, 500];
    await browse({ offset: 5000, currency: 'EUR' });
    expect(keyOfKind('books:shopband:', redisReads)).toEqual(gbp);
    expect(gbp.length).toBe(2);
  });

  // The guard on the fix, not the fix: a filter that *does* change the count must still
  // separate the entries, or removing currency would have been a licence to drop others.
  it('still separates keys on a filter that does change the count', async () => {
    await browse({ publisher: 'Faber' });
    const faber = keyOfKind('books:count:', redisReads);
    redisReads = [];
    await browse({ publisher: 'Verso' });
    expect(keyOfKind('books:count:', redisReads)).not.toEqual(faber);
  });
});

describe('the catalogue total', () => {
  // The whole-catalogue browse: the planner says millions, so counting them is skipped
  // entirely rather than bounded after the fact.
  it('is estimated, not counted, when the planner says the scan is large', async () => {
    planRows = 2_029_071;
    const result = await browse();
    expect(exactCountRuns).toBe(0);
    expect(result.total).toBe(2_029_071);
    expect(result.totalIsApproximate).toBe(true);
  });

  // A selective filter is where an exact number earns its keep and costs nothing, so the
  // threshold must not swallow it.
  it('is counted exactly when the planner says the scan is small', async () => {
    planRows = 312;
    exactCount = 312;
    const result = await browse({ publisher: 'Faber' });
    expect(exactCountRuns).toBe(1);
    expect(result.total).toBe(312);
    expect(result.totalIsApproximate).toBe(false);
  });

  // An estimate cached as exact would be reported as exact by every request the entry
  // serves for the next COUNT_TTL — the marker is what stops that.
  it('stays approximate when served from cache', async () => {
    cachedCount = '~2029071';
    const result = await browse();
    expect(exactCountRuns).toBe(0);
    expect(result.total).toBe(2_029_071);
    expect(result.totalIsApproximate).toBe(true);
  });

  it('reports a cached exact count as exact', async () => {
    cachedCount = '312';
    const result = await browse({ publisher: 'Faber' });
    expect(result.total).toBe(312);
    expect(result.totalIsApproximate).toBe(false);
  });

  it('writes the estimate marker so the distinction survives the cache', async () => {
    planRows = 2_029_071;
    await browse();
    const [, value] = cacheWrites.find(([k]) => k.startsWith('books:count:'))!;
    expect(value).toBe('~2029071');
  });

  // The planner calling a catalogue-sized scan small is the documented failure mode (see
  // the 9.5s Seq Scan in search-count-probes.test.ts), so the small branch is bounded too.
  it('falls back to the estimate when an exact count overruns its budget', async () => {
    planRows = 400;
    countError = Object.assign(new Error('canceling statement'), { code: '57014' });
    const result = await browse({ publisher: 'Faber' });
    expect(result.total).toBe(400);
    expect(result.totalIsApproximate).toBe(true);
  });

  // With no plan to read there is no second number to fall back to, so the count runs
  // unbounded rather than the browse failing over a caption.
  it('counts unbounded when the plan cannot be read', async () => {
    planRows = null;
    exactCount = 7;
    const result = await browse();
    expect(exactCountRuns).toBe(1);
    expect(result.total).toBe(7);
    expect(result.totalIsApproximate).toBe(false);
  });

  it('still asks the planner exactly once per uncached browse', async () => {
    planRows = 2_029_071;
    await browse();
    expect(explains.length).toBe(1);
  });
});
