import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Guards on what a search costs before it returns a single row.
 *
 * An uncached search runs count probes whose only product is the `total` caption. That
 * makes them invisible: nothing about the returned books changes when a probe degenerates,
 * so a regression here shows up as latency and nothing else. It has happened once already
 * — the probe that counts title and author matches together was written as a single scan
 * with the two conditions OR'd, Postgres could not estimate the author subquery and fell
 * back to a Seq Scan, and searches quietly went from milliseconds to 9.5 seconds each on a
 * 2M-row catalogue. No test failed, because every answer was still correct.
 *
 * These pin the cost properties instead: the shape of the SQL, which probes are allowed to
 * run at all, and what happens when one overruns.
 */

const dialect = new PgDialect();

// SQL text of every statement issued, in order, and the counts to hand back for them.
let issued: string[] = [];
let counts: number[] = [];
// Failure staged against the blended probe specifically — it is the only one wrapped in a
// timeout, and aiming at "whichever query runs first" would test the wrong thing.
let blendedError: unknown = null;

function render(query: unknown): string {
  try {
    return dialect.sqlToQuery(query as never).sql;
  } catch {
    return String(query);
  }
}

function execute(query: unknown): Promise<{ count: number }[]> {
  const text = render(query);
  // The GUC statements the probe wrappers emit are not probes; don't let them consume a
  // staged count or the assertions below would be counting the wrong thing.
  if (/^\s*SET\b/i.test(text)) return Promise.resolve([]);
  issued.push(text);
  if (blendedError && /UNION/i.test(text)) {
    const err = blendedError;
    blendedError = null;
    return Promise.reject(err);
  }
  return Promise.resolve([{ count: counts.shift() ?? 0 }]);
}

// A row fetch that yields nothing. Enough to let list() run its uncached-rows path, which
// is the only way to reach the state where rows must be fetched but the count need not be
// recomputed — the pagination case the blended probe is gated on.
function selectChain(): unknown {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };
  return chain;
}

vi.mock('../db', () => ({
  db: {
    execute,
    select: () => selectChain(),
    // withStatementTimeout runs its query inside a transaction so the SET is scoped.
    transaction: (fn: (tx: unknown) => unknown) => fn({ execute, select: () => selectChain() }),
  },
}));

let cachedRows: string | null = null;
let cachedCount: string | null = null;
let cacheWrites: [string, string][] = [];

vi.mock('../lib/redis', () => ({
  redis: {
    get: async (key: string) =>
      key.startsWith('books:list:') ? cachedRows : key.startsWith('books:count:') ? cachedCount : null,
    set: async (key: string, value: string) => {
      cacheWrites.push([key, value]);
      return 'OK';
    },
    del: async () => 1,
  },
}));

// vi.hoisted, because vi.mock is lifted above ordinary top-level declarations.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../lib/logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { booksService, buildAuthorMatchCondition } from '../services/books.service';

/** A cached page of `n` rows, so list() answers without touching the row-fetch path. */
function stageCachedPage(n: number, hasMore = true): void {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    title: `Book ${i + 1}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  cachedRows = JSON.stringify({ rows, hasMore, nextCursor: null });
}

const list = (o: Record<string, unknown> = {}) =>
  booksService.list({ q: 'hunt', limit: 20, offset: 0, dedupe: false, ...o } as never);

beforeEach(() => {
  issued = [];
  counts = [];
  blendedError = null;
  cachedRows = null;
  cachedCount = null;
  cacheWrites = [];
  warn.mockClear();
});

describe('the blended count probe', () => {
  // The regression, exactly: the probe that counts title and author matches together used
  // to render as one scan with `... OR "books"."id" IN (SELECT ...)`. Postgres cannot
  // estimate that subquery's cardinality, so it assumed half the table (994,218 of
  // 1,988,039 measured on production) and, with no BitmapOr able to serve an OR across a
  // trigram predicate and a membership test, chose a full Seq Scan — 9.5s and 1.42GB of
  // disk reads for a single probe. Both properties below are structural, because that is
  // the only level at which this is detectable without a 2M-row fixture.
  const orMembership = /\bOR\s+"books"\."id"\s+IN\s*\(/i;
  const topLevelUnion = /\)\s*UNION\s*\(\s*SELECT/i;

  it('unions two independently bounded branches instead of OR-ing them into one scan', async () => {
    stageCachedPage(5);
    counts = [3, 4, 7];
    await list();

    const blended = issued.find((sql) => topLevelUnion.test(sql));
    expect(blended, 'no probe unioned its branches at the top level').toBeDefined();
    // Each branch carries its own LIMIT. A single cap on the merged result would leave the
    // branches themselves unbounded, which is the cost this shape exists to bound.
    expect(blended!.match(/limit \$/gi)?.length).toBeGreaterThanOrEqual(2);
  });

  it('never ORs the author subquery into a title scan', async () => {
    stageCachedPage(5);
    counts = [3, 4, 7];
    await list();

    expect(
      issued.filter((sql) => orMembership.test(sql)),
      'a probe OR-d the author membership test into a single scan',
    ).toEqual([]);
  });

  it('keeps the author membership test conjunctive within its own branch', async () => {
    stageCachedPage(5);
    counts = [3, 4, 7];
    await list();

    const blended = issued.find((sql) => topLevelUnion.test(sql))!;
    // AND, not OR: the branch filters an already-indexed scan rather than widening it.
    expect(blended).toMatch(/and\s+"books"\."id"\s+IN\s*\(/i);
  });
});

describe('which probes are allowed to run', () => {
  // "Did the author side get probed?" has to be asked shape-agnostically. Keying off the
  // SQL the current implementation happens to emit makes the assertion pass trivially
  // against any version that merely spells the probe differently — including the slow one
  // this gate exists to retire.
  // Scoped to the count probes: the row fetch legitimately queries book_contributors for
  // the author branch of the page itself, and that is not what this gate governs.
  const authorProbes = () =>
    issued.filter((sql) => /COUNT\(\*\)/i.test(sql) && /book_contributors/i.test(sql));

  it('stops after the fast tier once it alone has reached the cap', async () => {
    stageCachedPage(5);
    // 1001 — the cap plus one, i.e. "at least SEARCH_COUNT_CAP". Nothing a wider probe
    // returns can move a total that is already clamped to the cap.
    counts = [1001];
    await list();
    expect(issued).toHaveLength(1);
  });

  it('runs the blended probe when the count is missing', async () => {
    stageCachedPage(20);
    cachedCount = null;
    counts = [3, 4, 7];
    await list();
    expect(authorProbes().length).toBeGreaterThan(0);
  });

  // The pagination case, and the reason this gate exists: the rows for a new offset are a
  // cache miss while the count — keyed page-independently, with a TTL 25 minutes longer —
  // is still warm. The title probes still have to run to choose a row tier, but the blended
  // probe has nothing left to contribute, and re-running it cost 3.5s for "harry&offset=20"
  // and 11.5s for "bookkeeping&offset=20" purely to recompute a number already in Redis.
  it('skips it when rows must be fetched but the count is cached', async () => {
    cachedRows = null;
    cachedCount = '398';
    counts = [3, 4];
    const r = await list({ offset: 20 });

    expect(
      authorProbes(),
      'the author side was probed despite the count already being cached',
    ).toEqual([]);
    expect(issued.length, 'title probes must still run, to pick a row tier').toBeGreaterThan(0);
    expect(r.total).toBe(398);
  });

  it('retires every probe once both rows and count are cached', async () => {
    stageCachedPage(20);
    cachedCount = '398';
    const r = await list();
    expect(issued).toEqual([]);
    expect(r.total).toBe(398);
  });
});

describe('when a probe overruns its statement timeout', () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), {
    code: '57014',
  });

  it('degrades to the title-only counts instead of failing the search', async () => {
    stageCachedPage(6);
    counts = [3, 4];
    blendedError = timeout;
    const r = await list();

    expect(r.totalIsApproximate).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(r.books).toHaveLength(6);     // the search still answers
  });

  it('does not cache a degraded count, so the next request retries', async () => {
    stageCachedPage(6);
    counts = [3, 4];
    blendedError = timeout;
    await list();

    // Caching a lower bound would pin it under COUNT_TTL — half an hour of a wrong caption
    // from one slow query.
    expect(cacheWrites.filter(([k]) => k.startsWith('books:count:'))).toEqual([]);
  });

  it('still propagates errors that are not a timeout', async () => {
    stageCachedPage(6);
    counts = [3, 4];
    blendedError = Object.assign(new Error('syntax error'), { code: '42601' });
    await expect(list()).rejects.toThrow('syntax error');
  });
});

describe('the reported total against the rows actually returned', () => {
  it('never reports fewer matches than the page it is captioning', async () => {
    // A search answered by the fuzzy tier: the probes count title and author matches and
    // find none, while the page comes back full. "0 results" over 20 books.
    cachedCount = '0';
    stageCachedPage(20);
    const r = await list();
    expect(r.total).toBe(20);
    expect(r.totalIsApproximate).toBe(true);
  });

  it('counts the offset into the floor, since earlier pages must exist too', async () => {
    cachedCount = '0';
    stageCachedPage(20);
    const r = await list({ offset: 40 });
    expect(r.total).toBe(60);
  });

  it('reads nothing into an empty page', async () => {
    // Paging past the end proves only that the result set is smaller than the offset —
    // flooring on offset alone would invent 40 matches for a search that has none.
    cachedCount = '0';
    stageCachedPage(0, false);
    const r = await list({ offset: 40 });
    expect(r.total).toBe(0);
    expect(r.totalIsApproximate).toBe(false);
  });

  it('leaves an exact count alone when the probes already agree', async () => {
    cachedCount = '398';
    stageCachedPage(20);
    const r = await list();
    expect(r.total).toBe(398);
    expect(r.totalIsApproximate).toBe(false);
  });
});
