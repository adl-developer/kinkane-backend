import { describe, it, expect, beforeEach, vi } from 'vitest';
import { books, bookContributors, userBooks, userDislikedBooks } from '../db/schema';
// vi.mock is hoisted above this import, so the lib picks up the mocked db/redis.
import { getUserExclusions } from '../lib/exclusions';

/**
 * Guards on the set that every recommendation surface filters against.
 *
 * It has two sources — books the user rejected, and books already on their
 * shelf — and the whole point of merging them here rather than at each call
 * site is that no surface can accidentally honour one and not the other. These
 * tests pin the merge, since a regression would be invisible: the feed would
 * just quietly start recommending books the user already owns.
 */

// Rows each table returns for the user under test. Set per-test.
let rowsByTable = new Map<unknown, unknown[]>();

function selectChain(): unknown {
  let table: unknown;
  const chain: Record<string, unknown> = {
    from: (t: unknown) => {
      table = t;
      return chain;
    },
    // Both the plain and the ordered query end here; awaiting either resolves
    // to whatever the test staged for that table.
    where: () => chain,
    orderBy: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsByTable.get(table) ?? []),
  };
  return chain;
}

vi.mock('../db', () => ({
  db: { select: () => selectChain() },
}));

// Cache miss on every read, and writes go nowhere — these tests are about what
// gets loaded, not what gets cached.
vi.mock('../lib/redis', () => ({
  redis: {
    get: async () => null,
    set: () => ({ catch: () => undefined }),
    del: async () => 1,
  },
}));

beforeEach(() => {
  rowsByTable = new Map();
});

/** Stages a shelf of books, with the catalogue rows resolveWorkSnapshots reads. */
function stageShelf(entries: { bookId: number; title: string; author?: string }[]) {
  rowsByTable.set(userBooks, entries.map((e) => ({ bookId: e.bookId })));
  rowsByTable.set(books, entries.map((e) => ({ id: e.bookId, title: e.title })));
  rowsByTable.set(
    bookContributors,
    entries
      .filter((e) => e.author)
      .map((e) => ({ bookId: e.bookId, personName: e.author })),
  );
}

describe('getUserExclusions', () => {
  it('merges rejected books and shelf books into one set', async () => {
    rowsByTable.set(userDislikedBooks, [
      { bookId: 1, title: 'dune', author: 'frank herbert' },
    ]);
    stageShelf([{ bookId: 2, title: 'The Silent Patient', author: 'Alex Michaelides' }]);

    const result = await getUserExclusions(7);

    expect(result.bookIds.sort()).toEqual([1, 2]);
    expect(result.works).toEqual(
      expect.arrayContaining([
        { title: 'dune', author: 'frank herbert' },
        { title: 'the silent patient', author: 'alex michaelides' },
      ]),
    );
  });

  it('normalizes shelf titles the same way a stored dislike already is', async () => {
    rowsByTable.set(userDislikedBooks, []);
    stageShelf([{ bookId: 2, title: '  Piranesi ', author: 'Susanna CLARKE' }]);

    const { works } = await getUserExclusions(7);

    expect(works).toEqual([{ title: 'piranesi', author: 'susanna clarke' }]);
  });

  it('keeps a shelf book with no known author as a title-only exclusion', async () => {
    rowsByTable.set(userDislikedBooks, []);
    stageShelf([{ bookId: 3, title: 'Anonymous Work' }]);

    const { works } = await getUserExclusions(7);

    expect(works).toEqual([{ title: 'anonymous work', author: null }]);
  });

  it('counts a book that is both on the shelf and rejected only once', async () => {
    rowsByTable.set(userDislikedBooks, [
      { bookId: 5, title: 'dune', author: 'frank herbert' },
    ]);
    stageShelf([{ bookId: 5, title: 'Dune', author: 'Frank Herbert' }]);

    const { bookIds, works } = await getUserExclusions(7);

    expect(bookIds).toEqual([5]);
    expect(works).toEqual([{ title: 'dune', author: 'frank herbert' }]);
  });

  it('collapses two shelf editions of the same work to one exclusion', async () => {
    rowsByTable.set(userDislikedBooks, []);
    stageShelf([
      { bookId: 10, title: 'Dune', author: 'Frank Herbert' },
      { bookId: 11, title: 'DUNE', author: 'Frank Herbert' },
    ]);

    const { bookIds, works } = await getUserExclusions(7);

    // Both catalogue rows still get excluded by ID — only the work-level
    // predicate collapses, since a second identical VALUES row buys nothing.
    expect(bookIds.sort()).toEqual([10, 11]);
    expect(works).toEqual([{ title: 'dune', author: 'frank herbert' }]);
  });

  it('degrades to no exclusions rather than throwing when the load fails', async () => {
    // Stands in for a dropped connection mid-query.
    const { db } = await import('../db');
    const failing = vi.spyOn(db, 'select').mockImplementation(() => {
      throw new Error('connection terminated');
    });

    await expect(getUserExclusions(7)).resolves.toEqual({ bookIds: [], works: [] });

    failing.mockRestore();
  });
});
