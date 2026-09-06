import { describe, it, expect, beforeEach, vi } from 'vitest';

// The controller half of these tests drives the real handler with the service
// mocked out, in the style of search-type.test.ts: what is being pinned is which
// options the endpoint hands downstream, not what the catalogue comes back with.
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

import { isbnFromQuery } from '../lib/isbn';
import { booksController } from '../controllers/books.controller';

/**
 * `?q=` is the one search box the UI has, so the number on the back of a book
 * gets typed into it. What matters here is the boundary: everything this
 * recognises is answered by an exact index lookup instead of the fuzzy search
 * ladder, and everything it does not recognise must still reach the search
 * untouched — a query wrongly claimed as an ISBN comes back empty, which is a
 * worse failure than a slow search.
 */
describe('isbnFromQuery', () => {
  it('takes a bare ISBN-13', () => {
    expect(isbnFromQuery('9781529219173')).toBe('9781529219173');
  });

  it('takes one as it is printed, with hyphens or spaces', () => {
    expect(isbnFromQuery('978-1-5292-1917-3')).toBe('9781529219173');
    expect(isbnFromQuery('978 1 5292 1917 3')).toBe('9781529219173');
    expect(isbnFromQuery('  9781529219173 ')).toBe('9781529219173');
  });

  it('converts an ISBN-10, since the catalogue only stores ISBN-13', () => {
    // 0-306-40615-2 → 978-0-306-40615-7, the worked example in the ISBN standard.
    expect(isbnFromQuery('0306406152')).toBe('9780306406157');
    expect(isbnFromQuery('0-306-40615-2')).toBe('9780306406157');
  });

  it('accepts X as an ISBN-10 check digit, and only there', () => {
    expect(isbnFromQuery('080442957X')).toBe('9780804429573');
    expect(isbnFromQuery('X804429570')).toBeNull();
  });

  it('rejects a 10-digit number that is not a valid ISBN-10', () => {
    // The checksum is what earns a bare 10-digit string the right to be treated
    // as an ISBN at all — otherwise an order or phone number typed into search
    // would be answered with "no such book" instead of being searched for.
    expect(isbnFromQuery('1234567890')).toBeNull();
  });

  it('leaves anything that is not an ISBN to the text search', () => {
    expect(isbnFromQuery('1984')).toBeNull();
    expect(isbnFromQuery('catch 22')).toBeNull();
    expect(isbnFromQuery('978152921917')).toBeNull(); // 12 digits — a partial ISBN
    expect(isbnFromQuery('97815292191730')).toBeNull(); // 14
    expect(isbnFromQuery('9781529219173 harry')).toBeNull();
    expect(isbnFromQuery('')).toBeNull();
  });

  it('passes a mistyped ISBN-13 through as a lookup rather than a search', () => {
    // Deliberate: 13 digits are an ISBN and nothing else, so a bad check digit
    // is a typo. Matching the `isbn=` parameter, which has never checksummed,
    // matters more here than catching the typo — both answer with no book.
    expect(isbnFromQuery('9781529219174')).toBe('9781529219174');
  });
});

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

describe('GET /books?q=<an ISBN>', () => {
  it('becomes an exact ISBN lookup instead of a search', async () => {
    // The point of the whole change: `q` must not survive into the options, or
    // the request still takes the fuzzy search path this exists to skip.
    const res = await call({ q: '9781529219173' });
    expect(res.statusCode).toBe(200);
    const opts = listSpy.mock.calls[0]![0];
    expect(opts).toMatchObject({ isbn: '9781529219173' });
    expect(opts.q).toBeUndefined();
  });

  it('normalises a printed ISBN and converts an ISBN-10', async () => {
    await call({ q: '978-1-5292-1917-3' });
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ isbn: '9781529219173' });

    await call({ q: '0306406152' });
    expect(listSpy.mock.calls[1]![0]).toMatchObject({ isbn: '9780306406157' });
  });

  it('keeps every other filter on the request', async () => {
    // The rewrite swaps one parameter for another and touches nothing else —
    // an ISBN lookup inside a genre is still an ISBN lookup inside a genre.
    await call({ q: '9781529219173', genre: 'literary-fiction', limit: '5' });
    expect(listSpy.mock.calls[0]![0]).toMatchObject({
      isbn: '9781529219173',
      genre: 'literary-fiction',
      limit: 5,
    });
  });

  it('leaves an ordinary search alone', async () => {
    await call({ q: 'the alchemist' });
    const opts = listSpy.mock.calls[0]![0];
    expect(opts).toMatchObject({ q: 'the alchemist' });
    expect(opts.isbn).toBeUndefined();
  });

  it('does not overwrite an ISBN the caller filtered on explicitly', async () => {
    // Two different ISBNs is a caller contradicting itself; the parameter that
    // says what it means wins, rather than being silently replaced by one
    // inferred from free text.
    await call({ q: '9781529219173', isbn: '9780306406157' });
    expect(listSpy.mock.calls[0]![0]).toMatchObject({
      isbn: '9780306406157',
      q: '9781529219173',
    });
  });
});
