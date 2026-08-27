import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The merge that only `GET /api/v1/books` still performs.
 *
 * v1 answers `?q=` from two branches — books matched by title, books matched by a
 * contributor's name — and interleaves them into one page. Which branch leads is a tuned
 * rule rather than a principled one, because there is no scale on which a title match and
 * a name match can be compared; that is the whole argument for v2, where the caller names
 * the side and no merge happens.
 *
 * None of this is visible from the SQL, and none of it was covered before v2 existed: the
 * merge was simply what the one search path did. Now it is one branch of three in
 * booksService.list, reachable only when `searchType` is absent, and the easiest thing in
 * this file to delete by accident while tidying up "the old path". These pin what a v1
 * client is still owed.
 */

const dialect = new PgDialect();

type Row = { id: number; title: string; createdAt: string; updatedAt: string };

const book = (id: number, title: string): Row => ({
  id,
  title,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

// Rows the title branch returns from its own index-ordered query, in that order.
let titleRows: Row[] = [];
// Rows reachable by contributor name, keyed by id — the author branch resolves ids to rows
// through a second query, so these are looked up rather than returned wholesale.
let catalogue: Row[] = [];
// Ids rankAuthorMatches hands back, best first. Tier/score are flattened to "the order this
// array is in", which is what byAuthorTierThenTitle would produce for distinct tiers.
let authorIds: number[] = [];
// Ids the fuzzy title pool ranks, best first. Empty means the broad title tier matched
// nothing, which is the state the exact-band shortcut is about.
let broadTitleIds: number[] = [];
let counts: number[] = [];

function render(query: unknown): string {
  try {
    return dialect.sqlToQuery(query as never).sql;
  } catch {
    return String(query);
  }
}

function whereIds(where: unknown): number[] | null {
  try {
    const { sql: text, params } = dialect.sqlToQuery(where as never);
    if (!/"books"\."id" in/i.test(text)) return null;
    return (params as unknown[]).filter((p): p is number => typeof p === 'number');
  } catch {
    return null;
  }
}

function execute(query: unknown): Promise<unknown[]> {
  const text = render(query);
  if (/^\s*SET\b/i.test(text)) return Promise.resolve([]);
  // The contributor ranking: ids plus the tier they matched at.
  if (/book_contributors/i.test(text) && !/COUNT\(\*\)/i.test(text)) {
    return Promise.resolve(authorIds.map((id, i) => ({ id, tier: i, score: 1 })));
  }
  // The fuzzy title pool.
  if (/word_similarity/i.test(text)) {
    return Promise.resolve(broadTitleIds.map((id) => ({ id })));
  }
  return Promise.resolve([{ count: counts.shift() ?? 0 }]);
}

function selectChain(): unknown {
  let ids: number[] | null = null;
  let ordered = false;
  const chain: Record<string, unknown> = {
    from: () => chain,
    // attachRelationsToList runs its own joined queries off the same db.select — they are
    // not what this file is about, and fall through to the empty result below.
    innerJoin: () => chain,
    leftJoin: () => chain,
    groupBy: () => chain,
    where: (w: unknown) => {
      ids = whereIds(w);
      return chain;
    },
    orderBy: () => {
      ordered = true;
      return chain;
    },
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) =>
      // An id-list query is a branch resolving its ranking to rows; anything ordered in SQL
      // is the title branch's own index-ordered fetch.
      resolve(ids !== null ? catalogue.filter((r) => ids!.includes(r.id)) : ordered ? titleRows : []),
  };
  return chain;
}

vi.mock('../db', () => ({
  db: {
    execute,
    select: () => selectChain(),
    transaction: (fn: (tx: unknown) => unknown) => fn({ execute, select: () => selectChain() }),
  },
}));

vi.mock('../lib/redis', () => ({
  redis: { get: async () => null, set: async () => 'OK', del: async () => 1 },
}));

vi.mock('../lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { booksService } from '../services/books.service';

beforeEach(() => {
  titleRows = [];
  catalogue = [];
  authorIds = [];
  broadTitleIds = [];
  counts = [];
});

// v1: no searchType at all. That absence is what selects the blended path.
const listV1 = (o: Record<string, unknown> = {}) =>
  booksService.list({ q: 'hunt', limit: 20, offset: 0, dedupe: false, ...o } as never);

const ids = (r: { books: { id: number }[] }) => r.books.map((b) => b.id);

describe('v1 merges both sides into one page', () => {
  it('leads with titles on the exact tiers', async () => {
    // A prefix or word-prefix title match is a strong signal, and a query is more often a
    // title than a name — so on the tiers where the title branch matched properly, it
    // leads. This is the ordinary case: it is what a v1 client sees for almost every
    // search it issues.
    counts = [5, 5];
    titleRows = [book(1, 'Hunting Season'), book(2, 'The Hunt')];
    catalogue = [book(10, 'Biff and Chip'), book(11, 'Kipper')];
    authorIds = [10, 11];

    expect(ids(await listV1())).toEqual([1, 2, 10, 11]);
  });

  it('returns a book matching on both sides once, at its leading branch position', async () => {
    // The merge dedupes by id rather than concatenating. Without this a book whose title
    // and author both match the query is printed twice on the same page, which is the
    // most visible way a naive merge fails.
    counts = [5, 5];
    titleRows = [book(1, 'Hunting Season'), book(10, 'Hunt for the Kipper')];
    catalogue = [book(10, 'Hunt for the Kipper'), book(11, 'Kipper')];
    authorIds = [10, 11];

    expect(ids(await listV1())).toEqual([1, 10, 11]);
  });

  it('leads with names once the title branch has fallen through to fuzzy matching', async () => {
    // The rule that exists for "Roderick Hunt": on the broad tier the title branch is
    // returning trigram near-misses, i.e. nothing matched a title properly. An exact name
    // match is a better answer than a fuzzy title one, so the branches swap.
    //
    // Reached by leaving both count probes at zero, which is what drops the ladder to
    // broad — and, with the exact band empty, is also what lets the fuzzy title pool run
    // at all rather than being short-circuited.
    counts = [0, 0];
    catalogue = [
      book(10, "Biff's Wonder Whistle"),
      book(20, 'Life of Sir Roderick I. Murchison'),
    ];
    authorIds = [10];
    broadTitleIds = [20];

    expect(ids(await listV1())).toEqual([10, 20]);
  });

  it('skips the fuzzy title pool entirely when the exact band still has rows', async () => {
    // Reaching the broad tier means no title matched a prefix at this offset. If the exact
    // band is not yet exhausted, what remains in it are name matches, and every one of
    // them outranks anything the fuzzy pool could produce — so running the most expensive
    // query in the search would only pad the page out beneath answers that are already
    // correct.
    counts = [0, 40];
    catalogue = [book(10, 'Biff and Chip'), book(11, 'Kipper')];
    authorIds = [10, 11];
    // Staged, and expected to go unused: if the pool runs, these appear in the page.
    broadTitleIds = [99];
    catalogue.push(book(99, 'A Fuzzy Near-Miss'));

    expect(ids(await listV1())).toEqual([10, 11]);
  });

  it('holds the cheap tier while the exact band has rows, counting names as supply', async () => {
    // The probes measure titles only, but a v1 page is titles merged with name matches, so
    // a title-only test abandons the tier while it still has plenty to give. Measured on
    // "roald dahl": 9 title-prefix matches, 13 with word prefixes, 40 rows once names are
    // counted — so at offset 20 the ladder fell to broad with half the supply unspent, and
    // because broad is a different ordering over a different set the raw offset landed near
    // the top of it. Page 3 reprinted page 1.
    counts = [9, 13, 40];
    titleRows = [];
    catalogue = Array.from({ length: 30 }, (_, i) => book(100 + i, `Name Match ${i}`));
    authorIds = catalogue.map((r) => r.id);
    broadTitleIds = [99];

    const page = await listV1({ offset: 20 });
    // Served from the cheap tier's own merge, not from the fuzzy pool the old title-only
    // test would have dropped to.
    expect(page.books.every((b) => b.id >= 100)).toBe(true);
  });
});

describe('v2 does not merge', () => {
  it('returns title matches only, even when names match the same query', async () => {
    // The behavioural difference between the versions, stated as one case: identical
    // staging, one parameter, and the author-matched books are simply absent.
    counts = [5, 5];
    titleRows = [book(1, 'Hunting Season'), book(2, 'The Hunt')];
    catalogue = [book(10, 'Biff and Chip'), book(11, 'Kipper')];
    authorIds = [10, 11];

    const v1 = await listV1();
    // Re-staged: the probes are consumed as they are read, and a second search over an
    // empty counts array would land on the broad tier rather than the one under test.
    counts = [5, 5];
    const v2 = await booksService.list({
      q: 'hunt', searchType: 'title', limit: 20, offset: 0, dedupe: false,
    } as never);

    expect(ids(v1)).toEqual([1, 2, 10, 11]);
    expect(ids(v2)).toEqual([1, 2]);
  });
});
