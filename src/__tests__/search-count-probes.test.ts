import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Guards on what a search costs before it returns a single row.
 *
 * An uncached search runs count probes whose only product is the `total` caption. That
 * makes them invisible: nothing about the returned books changes when a probe degenerates,
 * so a regression here shows up as latency and nothing else. It has happened once already
 * — back when one probe counted title and author matches together, it was written as a
 * single scan with the two conditions OR'd, Postgres could not estimate the author
 * subquery and fell back to a Seq Scan, and searches quietly went from milliseconds to 9.5
 * seconds each on a 2M-row catalogue. No test failed, because every answer was still
 * correct. That blended probe is gone now — `type` picks one side and only that side is
 * counted — but the OR guard below outlives it, because the shape is what was lethal.
 *
 * These pin the cost properties instead: the shape of the SQL, which probes are allowed to
 * run at all, and what happens when one overruns.
 */

const dialect = new PgDialect();

// SQL text of every statement issued, in order, and the counts to hand back for them.
let issued: string[] = [];
let issuedParams: unknown[][] = [];
let settings: string[] = [];
let counts: number[] = [];
// Failure staged against the author count probe specifically — it is the only probe
// wrapped in a timeout, and aiming at "whichever query runs first" would test the wrong
// thing.
let authorCountError: unknown = null;
// Lets a test fail a specific broad-tier pool stage, the way the time budget cancels one.
let poolFailure: (() => unknown) | null = null;

function render(query: unknown): string {
  try {
    return dialect.sqlToQuery(query as never).sql;
  } catch {
    return String(query);
  }
}

function params(query: unknown): unknown[] {
  try {
    return dialect.sqlToQuery(query as never).params as unknown[];
  } catch {
    return [];
  }
}

function execute(query: unknown): Promise<{ count: number }[]> {
  const text = render(query);
  // The GUC statements the wrappers emit are not queries; don't let them consume a staged
  // count or the assertions below would be counting the wrong thing.
  if (/^\s*SET\b/i.test(text)) {
    settings.push(text);
    return Promise.resolve([]);
  }
  issuedParams.push(params(query));
  issued.push(text);
  if (poolFailure && /word_similarity/i.test(text)) {
    const err = poolFailure();
    if (err) return Promise.reject(err);
  }
  // Keyed on the author count probe: a COUNT over the contributor match set. The row
  // fetch also queries book_contributors, so the COUNT is what distinguishes them.
  if (authorCountError && /COUNT\(\*\)/i.test(text) && /book_contributors/i.test(text)) {
    const err = authorCountError;
    authorCountError = null;
    return Promise.reject(err);
  }
  return Promise.resolve([{ count: counts.shift() ?? 0 }]);
}

// A row fetch that yields nothing. Enough to let list() run its uncached-rows path, which
// is the only way to reach the state where rows must be fetched but the count need not be
// recomputed — the pagination case the blended probe is gated on.
// The row fetches go through db.select(), not db.execute(), so they never reach `issued`.
// Their WHERE and ORDER BY are recorded here instead — which tier served a page, and
// whether its ordering breaks ties, are only visible in those two.
let selectWheres: string[] = [];
let selectOrderBys: string[] = [];

function selectChain(): unknown {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (w: unknown) => {
      if (w !== undefined) selectWheres.push(render(w));
      return chain;
    },
    orderBy: (...parts: unknown[]) => {
      selectOrderBys.push(parts.map(render).join(', '));
      return chain;
    },
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
  issuedParams = [];
  settings = [];
  counts = [];
  authorCountError = null;
  poolFailure = null;
  cachedRows = null;
  cachedCount = null;
  cacheWrites = [];
  selectWheres = [];
  selectOrderBys = [];
  warn.mockClear();
});

describe('the author count probe', () => {
  // The regression, exactly: the probe that counted title and author matches together used
  // to render as one scan with `... OR "books"."id" IN (SELECT ...)`. Postgres cannot
  // estimate that subquery's cardinality, so it assumed half the table (994,218 of
  // 1,988,039 measured on production) and, with no BitmapOr able to serve an OR across a
  // trigram predicate and a membership test, chose a full Seq Scan — 9.5s and 1.42GB of
  // disk reads for a single probe.
  //
  // Splitting title and author into separate searches removed the reason to ever write
  // that OR. The guard stays anyway: the shape is what was lethal, and nothing about
  // `type` stops someone reintroducing it.
  const orMembership = /\bOR\s+"books"\."id"\s+IN\s*\(/i;

  it('never ORs the author subquery into a title scan', async () => {
    stageCachedPage(5);
    counts = [3, 4];
    await list();

    expect(
      issued.filter((sql) => orMembership.test(sql)),
      'a probe OR-d the author membership test into a single scan',
    ).toEqual([]);
  });

  it('keeps the author membership test conjunctive within its own probe', async () => {
    cachedRows = null;
    cachedCount = null;
    counts = [7];
    await list({ searchType: 'author' });

    const probe = issued.find((sql) => /COUNT\(\*\)/i.test(sql) && /book_contributors/i.test(sql));
    expect(probe, 'an author search ran no count probe').toBeDefined();
    // AND, not OR: the probe filters an already-indexed scan rather than widening it.
    expect(probe!).toMatch(/and\s+"books"\."id"\s+IN\s*\(/i);
  });

  it('bounds the match set inside the subquery', async () => {
    cachedRows = null;
    cachedCount = null;
    counts = [7];
    await list({ searchType: 'author' });

    const probe = issued.find((sql) => /COUNT\(\*\)/i.test(sql) && /book_contributors/i.test(sql))!;
    // One cap on the outer count would leave the contributor scan itself unbounded, which
    // is the cost this shape exists to bound.
    expect(probe.match(/limit \$/gi)?.length).toBeGreaterThanOrEqual(2);
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

  it('never probes the author side for a title search', async () => {
    // The whole point of `type`: a title search has no reason to count names, and used to
    // pay for a blended union probe on every uncached search.
    stageCachedPage(20);
    cachedCount = null;
    counts = [3, 4];
    await list();
    expect(
      authorProbes(),
      'a title search probed the author side',
    ).toEqual([]);
  });

  it('probes the author side, and only that side, for an author search', async () => {
    stageCachedPage(20);
    cachedCount = null;
    counts = [7];
    await list({ searchType: 'author' });

    expect(authorProbes().length, 'an author search ran no author probe').toBeGreaterThan(0);
    // No title ladder: an author search does not choose between title tiers, so the two
    // title probes that used to run unconditionally have nothing to decide.
    expect(
      issued.filter((sql) => /COUNT\(\*\)/i.test(sql) && !/book_contributors/i.test(sql)),
      'an author search ran a title count probe',
    ).toEqual([]);
  });

  // The pagination case, and the reason this gate exists: the rows for a new offset are a
  // cache miss while the count — keyed page-independently, with a TTL 25 minutes longer —
  // is still warm. The title probes still have to run to choose a row tier, but the blended
  // probe has nothing left to contribute, and re-running it cost 3.5s for "harry&offset=20"
  // and 11.5s for "bookkeeping&offset=20" purely to recompute a number already in Redis.
  it('skips the count probe when rows must be fetched but the count is cached', async () => {
    cachedRows = null;
    cachedCount = '398';
    counts = [];
    const r = await list({ searchType: 'author', offset: 20 });

    expect(
      authorProbes(),
      'the author side was probed despite the count already being cached',
    ).toEqual([]);
    expect(r.total).toBe(398);
  });

  it('still runs the title probes on a cache miss, to pick a row tier', async () => {
    cachedRows = null;
    cachedCount = '398';
    counts = [3, 4];
    const r = await list({ offset: 20 });

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

  it('degrades to a lower-bound total instead of failing the search', async () => {
    stageCachedPage(6);
    counts = [];
    authorCountError = timeout;
    const r = await list({ searchType: 'author' });

    expect(r.totalIsApproximate).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(r.books).toHaveLength(6);     // the search still answers
  });

  it('does not cache a degraded count, so the next request retries', async () => {
    stageCachedPage(6);
    counts = [];
    authorCountError = timeout;
    await list({ searchType: 'author' });

    // Caching a lower bound would pin it under COUNT_TTL — half an hour of a wrong caption
    // from one slow query.
    expect(cacheWrites.filter(([k]) => k.startsWith('books:count:'))).toEqual([]);
  });

  it('still propagates errors that are not a timeout', async () => {
    stageCachedPage(6);
    counts = [];
    authorCountError = Object.assign(new Error('syntax error'), { code: '42601' });
    await expect(list({ searchType: 'author' })).rejects.toThrow('syntax error');
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

describe('the broad (fuzzy) tier', () => {
  // Reached only when nothing matched by prefix or word-prefix — every probe returns zero.
  const stageBroadTier = () => {
    cachedRows = null;
    cachedCount = null;
    counts = [0, 0, 0];
  };

  // The ranking — word_similarity() per row, then a sort — cannot be served by any index,
  // so Postgres must evaluate it for every matching row before an outer LIMIT can apply.
  // For a four-letter typo of a common word that is 506,996 rows, at which point the
  // planner drops the trigram index for a parallel seq scan of the whole table: 91s and
  // 6.5GB read from disk, measured on production. The cap has to sit inside the subquery
  // so it bounds what gets ranked; hoisting it to the outer query restores the original.
  it('ranks inside a bounded candidate pool rather than over every fuzzy match', async () => {
    stageBroadTier();
    await list();

    const pooled = issued.find((sql) => /word_similarity/i.test(sql) && /FROM\s*\(\s*SELECT/i.test(sql));
    expect(pooled, 'the broad tier issued no pooled query').toBeDefined();
    // The inner LIMIT caps the pool; the outer one only trims the ranked page.
    expect(pooled!.match(/limit \$/gi)?.length, 'expected an inner and an outer LIMIT').toBeGreaterThanOrEqual(2);
  });

  it('orders the pool, so paging does not resample it', async () => {
    stageBroadTier();
    await list();

    // An unordered LIMIT resamples between calls — verified against production, where two
    // identical "thhe" searches returned different pools. With the offset advancing per
    // page that puts a book on two pages or on none.
    const pooled = issued.find((sql) => /word_similarity/i.test(sql) && /FROM\s*\(\s*SELECT/i.test(sql))!;
    expect(pooled).toMatch(/order by\s+"books"\."id"\s*\n?\s*limit/i);
  });

  it('breaks ranking ties totally, down to a unique column', async () => {
    stageBroadTier();
    await list();

    // 166,111 titles tie at word_similarity 0.5 for "thhe". Without a tiebreak the order
    // within a tie is whatever the plan happens to produce — the unpooled form it replaces
    // returned different pages for identical searches 100s apart.
    const pooled = issued.find((sql) => /word_similarity/i.test(sql) && /FROM\s*\(\s*SELECT/i.test(sql))!;
    expect(pooled).toMatch(/lower\(c\.title\),\s*c\.id/i);
  });
});

describe('the fuzzy tier time budget', () => {
  const stageBroadTier = () => {
    cachedRows = null;
    cachedCount = null;
    counts = [0, 0, 0];
  };
  const poolQueries = () =>
    issued
      .map((sql, i) => ({ sql, params: issuedParams[i] }))
      .filter((x) => /word_similarity/i.test(x.sql) && /FROM\s*\(\s*SELECT/i.test(x.sql));

  // A statement_timeout cancels rather than returning partial rows, so "as much as fits in
  // the budget" is built by attempting a narrow pool first and widening only while time
  // remains. Measured on production, the narrow stage lands in 260-660ms for every term
  // tried, so there is almost always a ranking in hand before the wide attempt begins.
  it('tries a narrow pool first, then widens while the budget allows', async () => {
    stageBroadTier();
    await list();

    // The pool cap is the first numeric parameter — the filter's are all strings, and the
    // outer page limit comes after the ranking.
    const pools = poolQueries().map((x) => x.params.find((v) => typeof v === 'number'));
    expect(pools.length, 'expected the pool to be attempted in stages').toBeGreaterThanOrEqual(2);
    // Narrow first, then wider — never the other way round.
    expect(Number(pools[0])).toBeLessThan(Number(pools[1]));
  });

  it('bounds every stage with a statement timeout, not just the first', async () => {
    stageBroadTier();
    await list();
    const timeouts = settings.filter((sql) => /statement_timeout/i.test(sql));
    expect(timeouts.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the narrower ranking when the wider pool runs out of budget', async () => {
    stageBroadTier();
    // Let the narrow stage succeed, then cancel the wide one the way the budget would.
    let seen = 0;
    poolFailure = () => (++seen >= 2 ? Object.assign(new Error('canceling statement'), { code: '57014' }) : null);

    const r = await list();
    // The search still answers, from the stage that completed, rather than failing.
    expect(r.books).toBeDefined();
    expect(warn).toHaveBeenCalled();
  });

  it('still propagates a non-timeout failure from a stage', async () => {
    stageBroadTier();
    poolFailure = () => Object.assign(new Error('relation missing'), { code: '42P01' });
    await expect(list()).rejects.toThrow('relation missing');
  });
});

describe("which tier an author search's own ladder uses", () => {
  // The regression this pins: the author branch used to inherit the *title* branch's tier,
  // so a query that matched no title prefix sent the author lookup straight to its fuzzy
  // tier — a trigram/FTS scan over the whole contributor table. On the production
  // catalogue that exceeded the broad tier's time budget, was cancelled, and the branch
  // returned nothing.
  //
  // Splitting the sides makes lockstep escalation impossible by construction — there is no
  // title tier left to inherit. What still has to hold is the ladder inside the author
  // search: cheap first, fuzzy only if the cheap tier matched nothing at all. "peace adzo
  // medie" matches no title prefix but is an exact prefix of a person_name, which the
  // cheap tier answers from the name index in microseconds.
  //
  // Asserted on the SQL, because the difference is invisible in the returned rows: both
  // tiers return author matches, and the broken one returned none only at a scale no unit
  // test can reproduce.
  const stageAuthorSearch = () => {
    cachedRows = null;
    cachedCount = null;
    counts = [0];
  };

  // The author search's own row-fetch queries — not the count probe, which always uses the
  // cheap tier and is governed separately above.
  const authorFetches = () =>
    issued.filter((sql) => /book_contributors/i.test(sql) && !/COUNT\(\*\)/i.test(sql));

  // `<%` and the FTS pass over person_name are what make the fuzzy tier expensive; the
  // cheap tier has neither.
  const isFuzzyAuthorSql = (sql: string) => /<%/.test(sql) || /to_tsvector\('simple'/i.test(sql);

  it('tries the cheap tier first', async () => {
    stageAuthorSearch();
    await list({ searchType: 'author' });

    const fetches = authorFetches();
    expect(fetches.length, 'the author search issued no query at all').toBeGreaterThan(0);
    expect(
      fetches.some((sql) => !isFuzzyAuthorSql(sql)),
      'every author query used the fuzzy tier — the cheap tier was skipped entirely',
    ).toBe(true);
  });

  it('asks the cheap tier before the fuzzy one, never the other way round', async () => {
    stageAuthorSearch();
    await list({ searchType: 'author' });

    const fetches = authorFetches();
    const firstFuzzy = fetches.findIndex(isFuzzyAuthorSql);
    const firstCheap = fetches.findIndex((sql) => !isFuzzyAuthorSql(sql));

    expect(firstCheap, 'no cheap author query was issued').toBeGreaterThanOrEqual(0);
    if (firstFuzzy >= 0) {
      expect(firstCheap).toBeLessThan(firstFuzzy);
    }
  });

  it('never runs the title ladder for an author search', async () => {
    stageAuthorSearch();
    await list({ searchType: 'author' });

    // The fuzzy *title* pool is the most expensive query a search can run. An author
    // search has no business reaching it, whatever its own tier ends up being.
    expect(
      issued.filter((sql) => /word_similarity/i.test(sql) && /FROM\s*\(\s*SELECT/i.test(sql)),
      'an author search ran the fuzzy title pool',
    ).toEqual([]);
  });

  it('leaves the fuzzy escalation inside the time budget', async () => {
    stageAuthorSearch();
    await list({ searchType: 'author' });

    // The escalation is still the branch that can overrun, so it must stay wrapped — a
    // cheap-first branch that ran the fuzzy tier unguarded would trade one failure mode
    // for a worse one.
    const fetches = authorFetches();
    if (fetches.some(isFuzzyAuthorSql)) {
      expect(settings.filter((sql) => /statement_timeout/i.test(sql)).length).toBeGreaterThan(0);
    }
  });
});

describe('when the exact band already has rows', () => {
  // The fuzzy pool is the most expensive query a search can run — a word_similarity
  // ranking over a bounded candidate pool, and the multi-second part on a full catalogue.
  // It is reserved for queries the cheap tiers cannot answer *at all* at this offset:
  // returning a handful of genuine prefix matches is both far faster and better ranked
  // than padding a page out with fuzzy near-misses.
  //
  // Staged as counts rather than rows because that is how the decision is actually made:
  // deriving it from what the fetch returned would make page 2 of a query answer
  // differently from page 1.
  const poolQueries = () =>
    issued.filter((sql) => /word_similarity/i.test(sql) && /FROM\s*\(\s*SELECT/i.test(sql));

  it('skips the fuzzy pool while the cheap tier still has rows', async () => {
    cachedRows = null;
    cachedCount = null;
    // fast = 0 sends it past the fast tier, but the cheap tier matched 3 — which is
    // supply the fuzzy pool has nothing to add above.
    counts = [0, 3];
    await list();

    expect(poolQueries(), 'the fuzzy pool ran despite an exact title match').toEqual([]);
  });

  it('still runs the fuzzy pool when nothing matched exactly at all', async () => {
    cachedRows = null;
    cachedCount = null;
    counts = [0, 0];
    await list();

    // The converse, so the test above cannot be satisfied by never running the pool.
    expect(poolQueries().length).toBeGreaterThan(0);
  });

  it('does not change its mind between pages when the count is cached', async () => {
    // Paginating recomputes the title probes but not the count, which is cached under a
    // page-independent key. If the band decision read only the freshly computed probes it
    // would see zero here and drop to the fuzzy tier that page 1 skipped.
    cachedRows = null;
    cachedCount = '3';
    counts = [0, 0];
    await list({ offset: 0 });

    expect(poolQueries(), 'a later page fell to the fuzzy tier the first page skipped').toEqual([]);
  });
});

describe('which tier serves a deep page', () => {
  // The tier decides both which rows exist and what order they come in, so a query that
  // changes tier partway through pagination restarts partway down a different list. That
  // is not theoretical: q="harry" changed tier partway through pagination and page 3
  // reprinted page 1. The band the ladder measures is now exactly the side being searched,
  // which is what makes the count and the rows agree about what is left.
  const poolQueries = () =>
    issued.filter((sql) => /word_similarity/i.test(sql) && /FROM\s*\(\s*SELECT/i.test(sql));

  it('stays on the cheap tier while the exact band still has rows', async () => {
    cachedRows = null;
    cachedCount = null;
    // The fast tier cannot fill this page, but the cheap tier has 50 matches — far past
    // the offset, so the ladder must hold rather than escalate.
    counts = [0, 50];
    await list({ offset: 20, limit: 10 });

    // The cheap tier fetches its titles with the prefix/word-prefix condition. The broad
    // tier never issues that fetch at all, so its presence is what identifies the tier.
    expect(
      selectWheres.some((w) => /ilike/i.test(w) && !/<%/.test(w)),
      'no cheap-tier title fetch — the tier fell through while the band still had rows',
    ).toBe(true);
    expect(poolQueries(), 'the fuzzy pool ran while the exact band still had rows').toEqual([]);
  });

  it('still falls to broad once the whole band is exhausted', async () => {
    cachedRows = null;
    cachedCount = null;
    counts = [0, 8];
    await list({ offset: 20, limit: 10 });

    // The converse: the guard must be a real test of supply, not a way to never escalate.
    expect(poolQueries().length).toBeGreaterThan(0);
  });

  it('orders every title fetch by a column that breaks every tie', async () => {
    // Each page fetches a larger LIMIT than the last, so without a total order two pages
    // get different arbitrary subsets of the tied rows and overlap. Editions of one book
    // share a title exactly, so ties are common rather than exotic — this accounted for
    // every remaining repeat on q="harry" once the tier flip above was fixed.
    cachedRows = null;
    cachedCount = null;
    counts = [500, 500];
    await list({ offset: 0, limit: 10 });

    expect(selectOrderBys.length, 'no ordered row fetch was issued').toBeGreaterThan(0);
    for (const ordering of selectOrderBys) {
      expect(ordering, `ordering has no id tiebreak: ${ordering}`).toMatch(/"id"(\s+asc)?\s*$/i);
    }
  });
});
