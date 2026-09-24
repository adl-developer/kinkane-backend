import { describe, it, expect, beforeEach, vi } from 'vitest';
import { users, userBooks } from '../db/schema';
// vi.mock is hoisted above this import, so the service picks up the mocked db.
import { recommendationsService } from '../services/recommendations.service';

/**
 * Guards on recommendationsService.saveSelections writing the re-inferred reader
 * type back to `users.reader_type`.
 *
 * This used to be deliberately skipped: a retake recorded its newly inferred
 * type in the preference history and left the user row alone, so settings kept
 * showing the label from signup and the "readers like you" rail kept reading the
 * signup cohort. These tests exist to keep that from coming back — and to keep a
 * failed inference from clearing a type the reader already had.
 */

// What fetchAndInferReaderType returns for the call under test.
let inferred: string | null = 'The Seeker';

// Every `update()` the call makes, as { table, values }.
const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
// Every `insert()` the call makes, as { table, values }.
const inserts: Array<{ table: unknown; values: unknown }> = [];
// Every history row recorded, as the options passed to `record`.
const historyCalls: Array<{ readerType?: string | null }> = [];

const CHOSEN = [1, 2];

function chainableUpdate(table: unknown) {
  const chain = {
    set: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      return chain;
    },
    where: async () => undefined,
  };
  return chain;
}

function fakeTx() {
  return {
    update: (table: unknown) => chainableUpdate(table),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoNothing: async () => {
          inserts.push({ table, values });
        },
      }),
    }),
  };
}

vi.mock('../db', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx()),
    update: (table: unknown) => chainableUpdate(table),
    // The book-ID validation read: every chosen ID resolves to a catalogue row,
    // so the call gets past the 400 and on to the writes under test.
    select: () => ({
      from: () => ({
        where: async () => CHOSEN.map((id) => ({ id, title: `Book ${id}`, coverUrl: null })),
      }),
    }),
  },
}));

vi.mock('../lib/reader-type', () => ({
  fetchAndInferReaderType: async () => inferred,
}));

vi.mock('../services/preference-history.service', () => ({
  preferenceHistoryService: {
    record: async (_userId: number, _prefs: unknown, _source: string, options?: { readerType?: string | null }) => {
      historyCalls.push(options ?? {});
    },
  },
}));

vi.mock('../services/disliked-books.service', () => ({
  dislikedBooksService: { record: async () => undefined, listBookIds: async () => [] },
}));

vi.mock('../lib/exclusions', () => ({
  bustUserExclusions: async () => undefined,
  bustPersonalizedFeedCache: async () => undefined,
  getUserExclusions: async () => ({ bookIds: [], works: [] }),
  buildHasAuthorCondition: () => undefined,
  buildWorkExclusionCondition: () => undefined,
  normalizeForMatch: (s: string) => s,
  EMPTY_EXCLUSIONS: { bookIds: [], works: [] },
}));

function readerTypeUpdates() {
  return updates.filter((u) => u.table === users && 'readerType' in u.values);
}

describe('saveSelections (reader type after a quiz retake)', () => {
  beforeEach(() => {
    updates.length = 0;
    inserts.length = 0;
    historyCalls.length = 0;
    inferred = 'The Seeker';
    // getPreferences is only called to build the history snapshot, which these
    // tests read off the mocked `record` rather than the database.
    vi.spyOn(recommendationsService, 'getPreferences').mockResolvedValue({
      feelings: [],
      bookIds: CHOSEN,
      genres: [],
      dislikes: {},
      dislikedBookIds: [],
    } as never);
  });

  it('writes the newly inferred reader type to the user row', async () => {
    const result = await recommendationsService.saveSelections(7, CHOSEN);

    expect(readerTypeUpdates()).toHaveLength(1);
    expect(readerTypeUpdates()[0].values.readerType).toBe('The Seeker');
    expect(result.readerType).toBe('The Seeker');
  });

  it('leaves the existing reader type alone when inference fails', async () => {
    inferred = null;

    const result = await recommendationsService.saveSelections(7, CHOSEN);

    // No write at all, rather than a write of null — a Gemini failure must not
    // blank out a label the reader already had.
    expect(readerTypeUpdates()).toEqual([]);
    expect(result.readerType).toBeNull();
  });

  it('records the inferred type in the preference history', async () => {
    await recommendationsService.saveSelections(7, CHOSEN);

    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0].readerType).toBe('The Seeker');
  });

  it('lets the history carry the existing type forward when inference fails', async () => {
    inferred = null;

    await recommendationsService.saveSelections(7, CHOSEN);

    // undefined, not null: `record` then reads the user row and snapshots the
    // type they still have, instead of logging "this reader has no type".
    expect(historyCalls).toHaveLength(1);
    expect(historyCalls[0].readerType).toBeUndefined();
  });

  it('still puts the chosen books on the shelf', async () => {
    await recommendationsService.saveSelections(7, CHOSEN);

    // The reader-type write shares a transaction with the shelf write, so a
    // mistake in one can swallow the other.
    const shelfRows = inserts.find((i) => i.table === userBooks)?.values as
      | Array<{ bookId: number }>
      | undefined;
    expect(shelfRows?.map((r) => r.bookId)).toEqual(CHOSEN);
    expect(readerTypeUpdates()).toHaveLength(1);
  });
});
