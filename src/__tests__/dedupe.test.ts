import { describe, it, expect } from 'vitest';
import {
  dedupeByTitle,
  dedupeByTitleAndSubtitle,
  dedupeByWork,
  dedupeCardsByWork,
  firstNamedAuthor,
  groupEditions,
  normalizeWorkText,
  workKey,
  type DedupeCandidate,
} from '../lib/dedupe';

interface Row extends DedupeCandidate {
  id: number;
}

// A fully "complete" edition: cover, description, a genre, orderable, dated, priced.
const complete = (overrides: Partial<Row> = {}): Omit<Row, 'id' | 'title' | 'subtitle'> => ({
  coverUrl: 'https://example.com/cover.jpg',
  shortDescription: 'A gripping tale.',
  genreCount: 1,
  availabilityCode: '20',
  publicationDate: '2020-01-01',
  hasPrice: true,
  ...overrides,
});

const bare = (overrides: Partial<Row> = {}): Omit<Row, 'id' | 'title' | 'subtitle'> => ({
  coverUrl: null,
  shortDescription: null,
  genreCount: 0,
  availabilityCode: null,
  publicationDate: null,
  hasPrice: false,
  ...overrides,
});

describe('dedupeByTitle', () => {
  it('drops later rows with the same title', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null, ...bare() },
      { id: 2, title: 'Dune', subtitle: null, ...bare() },
    ];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([1]);
  });

  it('is case-insensitive and trims whitespace', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null, ...bare() },
      { id: 2, title: '  DUNE  ', subtitle: null, ...bare() },
    ];
    expect(dedupeByTitle(rows)).toHaveLength(1);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeByTitle([])).toEqual([]);
  });

  it('prefers a row with a cover over one without, regardless of arrival order', () => {
    const withCover: Row = { id: 1, title: 'Dune', subtitle: null, ...bare(), coverUrl: 'https://example.com/a.jpg' };
    const withoutCover: Row = { id: 2, title: 'Dune', subtitle: null, ...bare() };

    expect(dedupeByTitle([withoutCover, withCover]).map((r) => r.id)).toEqual([1]);
    expect(dedupeByTitle([withCover, withoutCover]).map((r) => r.id)).toEqual([1]);
  });

  it('prefers a complete dataset over cover-only when both have covers', () => {
    const coverOnly: Row = { id: 1, title: 'Dune', subtitle: null, ...bare(), coverUrl: 'https://example.com/a.jpg' };
    const full: Row = { id: 2, title: 'Dune', subtitle: null, ...complete() };

    const result = dedupeByTitle([coverOnly, full]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('among two covered+complete editions, prefers the more recent publication date', () => {
    const older: Row = { id: 1, title: 'Dune', subtitle: null, ...complete({ publicationDate: '2010-01-01' }) };
    const newer: Row = { id: 2, title: 'Dune', subtitle: null, ...complete({ publicationDate: '2022-06-15' }) };

    expect(dedupeByTitle([older, newer])[0].id).toBe(2);
    expect(dedupeByTitle([newer, older])[0].id).toBe(2);
  });

  it('treats a missing publication date as older than any dated edition', () => {
    const dated: Row = { id: 1, title: 'Dune', subtitle: null, ...complete({ publicationDate: '2010-01-01' }) };
    const undated: Row = { id: 2, title: 'Dune', subtitle: null, ...complete({ publicationDate: null }) };

    expect(dedupeByTitle([undated, dated])[0].id).toBe(1);
  });

  it('falls back to price when cover, completeness, and date all tie', () => {
    const noPrice: Row = { id: 1, title: 'Dune', subtitle: null, ...complete({ hasPrice: false }) };
    const priced: Row = { id: 2, title: 'Dune', subtitle: null, ...complete({ hasPrice: true }) };

    expect(dedupeByTitle([noPrice, priced])[0].id).toBe(2);
  });

  it('keeps the first-seen row when every criterion ties (stable tie-break)', () => {
    const a: Row = { id: 1, title: 'Dune', subtitle: null, ...complete() };
    const b: Row = { id: 2, title: 'Dune', subtitle: null, ...complete() };

    expect(dedupeByTitle([a, b])[0].id).toBe(1);
  });

  it('a book missing any one completeness field (description, genre, availability) counts as incomplete', () => {
    const noDescription: Row = { id: 1, title: 'Dune', subtitle: null, ...complete({ shortDescription: null }) };
    const noGenre: Row = { id: 2, title: 'Dune', subtitle: null, ...complete({ genreCount: 0 }) };
    const notOrderable: Row = { id: 3, title: 'Dune', subtitle: null, ...complete({ availabilityCode: '31' }) };
    const full: Row = { id: 4, title: 'Dune', subtitle: null, ...complete() };

    for (const incomplete of [noDescription, noGenre, notOrderable]) {
      expect(dedupeByTitle([incomplete, full])[0].id).toBe(4);
    }
  });

  it('preserves the position of the first occurrence even when a later row wins on content', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null, ...bare() },
      { id: 2, title: 'Frank Herbert', subtitle: null, ...bare() },
      { id: 3, title: 'Dune', subtitle: null, ...complete() },
    ];
    const result = dedupeByTitle(rows);
    expect(result.map((r) => r.id)).toEqual([3, 2]);
  });
});

describe('dedupeByTitleAndSubtitle', () => {
  it('drops later rows with the same title and subtitle', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null, ...bare() },
      { id: 2, title: 'Dune', subtitle: null, ...bare() },
    ];
    expect(dedupeByTitleAndSubtitle(rows).map((r) => r.id)).toEqual([1]);
  });

  it('keeps rows with the same title but different subtitles', () => {
    const rows: Row[] = [
      { id: 1, title: 'Poems', subtitle: 'Collected Works', ...bare() },
      { id: 2, title: 'Poems', subtitle: 'Selected Works', ...bare() },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(2);
  });

  it('keeps rows with different titles but the same subtitle', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: 'A Novel', ...bare() },
      { id: 2, title: 'Shogun', subtitle: 'A Novel', ...bare() },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(2);
  });

  it('treats null and empty-string subtitles as the same key', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null, ...bare() },
      { id: 2, title: 'Dune', subtitle: '', ...bare() },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(1);
  });

  it('picks the better-scoring row even across a case/whitespace-normalized key', () => {
    const messy: Row = { id: 1, title: '  DUNE  ', subtitle: '  a novel  ', ...bare() };
    const clean: Row = { id: 2, title: 'Dune', subtitle: 'A Novel', ...complete() };
    expect(dedupeByTitleAndSubtitle([messy, clean])[0].id).toBe(2);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeByTitleAndSubtitle([])).toEqual([]);
  });
});

// Every /books endpoint shows one edition per title, and which one is a product rule:
// stock tier first (on the shelf > order-in > cannot be bought), then paperback >
// hardback > any other format — and only then the content rules above.
describe('edition format preference', () => {
  const IN_STOCK = 0;
  const TO_ORDER = 1;
  const UNAVAILABLE = 2;
  const ed = (id: number, productForm: string | null, overrides: Partial<Row> = {}): Row => ({
    id,
    title: 'Dune',
    subtitle: null,
    ...complete({ productForm, stockTier: IN_STOCK }),
    ...overrides,
  });

  it('shows the hardback when paperback, hardback and other formats all exist', () => {
    const rows = [ed(1, 'AB'), ed(2, 'BC'), ed(3, 'BB')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([3]);
  });

  it('falls back to the paperback when there is no hardback', () => {
    const rows = [ed(1, 'EA'), ed(2, 'BC'), ed(3, 'AB')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('uses any other format when there is neither', () => {
    const rows = [ed(1, 'EA'), ed(2, 'AB')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([1]);
  });

  it('prefers the hardback even over a paperback with a cover and a complete record', () => {
    const rows = [ed(1, 'BC'), ed(2, 'BB', bare({ productForm: 'BB', stockTier: IN_STOCK }))];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('prefers an in-stock paperback over a hardback that cannot be bought', () => {
    const rows = [ed(1, 'BB', { stockTier: UNAVAILABLE }), ed(2, 'BC')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  // The shop lists in-stock books first; leading that section with an order-in
  // hardback while the paperback is on the shelf is what this rule prevents.
  it('prefers an in-stock paperback over an order-in hardback', () => {
    const rows = [ed(1, 'BB', { stockTier: TO_ORDER }), ed(2, 'BC')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('prefers an order-in paperback over a hardback that cannot be bought', () => {
    const rows = [ed(1, 'BB', { stockTier: UNAVAILABLE }), ed(2, 'BC', { stockTier: TO_ORDER })];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('prefers the hardback among order-in editions', () => {
    const rows = [ed(1, 'BC', { stockTier: TO_ORDER }), ed(2, 'BB', { stockTier: TO_ORDER })];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('still prefers the hardback when no edition can be bought', () => {
    const rows = [ed(1, 'BC', { stockTier: UNAVAILABLE }), ed(2, 'BB', { stockTier: UNAVAILABLE })];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('breaks a tie between two paperbacks on the existing content rules', () => {
    const rows = [
      ed(1, 'BC', { coverUrl: null }),
      ed(2, 'BC', { publicationDate: '2019-01-01' }),
      ed(3, 'BC', { publicationDate: '2023-01-01' }),
    ];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([3]);
  });

  it('reads the ONIX code case- and whitespace-insensitively', () => {
    const rows = [ed(1, 'BC'), ed(2, ' bb ')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  // The recommendation engine shares this picker but supplies neither field; its
  // ordering must not change underneath it.
  it('leaves the old ordering alone for callers that pass no format or stock', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null, ...bare() },
      { id: 2, title: 'Dune', subtitle: null, ...complete() },
    ];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });
});

describe('normalizeWorkText', () => {
  it.each([
    ['The Hobbit', 'hobbit'],
    ['Hobbit, The', 'hobbit'],
    ['  the  hobbit. ', 'hobbit'],
    ['A Return to Love', 'return to love'],
    ['Goodbye, Eastern Europe', 'goodbye eastern europe'],
    ['Bridget & Gabe', 'bridget and gabe'],
    ['Les Misérables', 'les miserables'],
    ['Don’t Look Now', 'don t look now'],
    ["Don't Look Now", 'don t look now'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeWorkText(input)).toBe(expected);
  });

  it('keeps an article that is the whole title or mid-title', () => {
    expect(normalizeWorkText('A')).toBe('a');
    expect(normalizeWorkText('Anna and the King')).toBe('anna and the king');
  });

  it('does not strip subtitles, so series entries stay distinct', () => {
    expect(normalizeWorkText('Deadly! Irish History - The Vikings')).not.toBe(
      normalizeWorkText('Deadly! Irish History - The Celts'),
    );
    expect(normalizeWorkText('Mistborn: Secret History')).not.toBe(normalizeWorkText('Mistborn'));
  });
});

describe('workKey', () => {
  it('matches spelling variants of one work by one author', () => {
    expect(workKey('The Odyssey', 'Homer')).toBe(workKey('Odyssey', 'HOMER '));
  });

  it('separates same-titled books by different authors', () => {
    expect(workKey('Home', 'Toni Morrison')).not.toBe(workKey('Home', 'Marilynne Robinson'));
  });
});

describe('dedupeByWork', () => {
  type WorkRow = Row & { author: string | null };

  it('collapses title variants of the same work to the best edition, in first position', () => {
    const rows: WorkRow[] = [
      { id: 1, title: 'The Green Mile', author: 'Stephen King', subtitle: null, ...bare() },
      { id: 2, title: 'Carrie', author: 'Stephen King', subtitle: null, ...bare() },
      { id: 3, title: 'Green Mile', author: 'Stephen King', subtitle: null, ...complete() },
    ];
    expect(dedupeByWork(rows).map((r) => r.id)).toEqual([3, 2]);
  });

  it('keeps same-titled books by different authors', () => {
    const rows: WorkRow[] = [
      { id: 1, title: 'Home', author: 'Toni Morrison', subtitle: null, ...bare() },
      { id: 2, title: 'Home', author: 'Marilynne Robinson', subtitle: null, ...bare() },
    ];
    expect(dedupeByWork(rows)).toHaveLength(2);
  });

  it('never recommends both "X" and "The X"', () => {
    const rows: WorkRow[] = [
      { id: 1, title: "Secret Lives of Baba Segi's Wives", author: 'Lola Shoneyin', subtitle: null, ...complete() },
      { id: 2, title: "The Secret Lives of Baba Segi's Wives", author: 'Lola Shoneyin', subtitle: null, ...complete() },
    ];
    expect(dedupeByWork(rows)).toHaveLength(1);
  });

  describe('picks cover, then newest, then price, then most data', () => {
    const work = (id: number, overrides: Partial<Row>): WorkRow => ({
      id,
      title: 'Dune',
      author: 'Frank Herbert',
      subtitle: null,
      ...complete(),
      ...overrides,
    });

    it('prefers a cover over a newer edition without one', () => {
      const rows = [work(1, { coverUrl: null, publicationDate: '2024-01-01' }), work(2, { publicationDate: '2001-01-01' })];
      expect(dedupeByWork(rows).map((r) => r.id)).toEqual([2]);
    });

    it('prefers the newest among editions with covers, even over a more complete record', () => {
      const rows = [
        work(1, { publicationDate: '2001-01-01' }),
        work(2, { publicationDate: '2024-01-01', shortDescription: null, genreCount: 0, hasPrice: false }),
      ];
      expect(dedupeByWork(rows).map((r) => r.id)).toEqual([2]);
    });

    it('prefers a priced edition when cover and date tie', () => {
      const rows = [work(1, { hasPrice: false }), work(2, { shortDescription: null, genreCount: 0 })];
      expect(dedupeByWork(rows).map((r) => r.id)).toEqual([2]);
    });

    it('prefers more data points when everything else ties', () => {
      const rows = [work(1, { shortDescription: null, genreCount: 0 }), work(2, { shortDescription: null })];
      expect(dedupeByWork(rows).map((r) => r.id)).toEqual([2]);
    });

    it('ignores format — a recommendation is one card per book', () => {
      const rows = [work(1, { productForm: 'BB' }), work(2, { productForm: 'BC', publicationDate: '2024-01-01' })];
      expect(dedupeByWork(rows).map((r) => r.id)).toEqual([2]);
    });

    it('still puts an edition on the shelf first when stock is known', () => {
      const rows = [work(1, { stockTier: 1, publicationDate: '2024-01-01' }), work(2, { stockTier: 0 })];
      expect(dedupeByWork(rows).map((r) => r.id)).toEqual([2]);
    });
  });
});

describe('firstNamedAuthor', () => {
  it('takes the lowest-sequence named A01', () => {
    expect(
      firstNamedAuthor([
        { role: 'B01', personName: 'An Editor', sequenceNumber: 1 },
        { role: 'A01', personName: '  ', sequenceNumber: 2 },
        { role: 'A01', personName: 'Second', sequenceNumber: 4 },
        { role: 'A01', personName: 'First', sequenceNumber: 3 },
      ]),
    ).toBe('First');
  });

  it('is null with no named author', () => {
    expect(firstNamedAuthor([{ role: 'B01', personName: 'Ed', sequenceNumber: 1 }])).toBeNull();
  });
});

describe('dedupeCardsByWork', () => {
  it('keys on the first author from contributors', () => {
    const card = (id: number, title: string, author: string) => ({
      id,
      title,
      subtitle: null,
      contributors: [{ role: 'A01', personName: author, sequenceNumber: 1 }],
      ...complete(),
    });
    const rows = [card(1, 'Home', 'Toni Morrison'), card(2, 'The Home', 'Toni Morrison'), card(3, 'Home', 'Marilynne Robinson')];
    expect(dedupeCardsByWork(rows).map((r) => r.id)).toEqual([1, 3]);
  });
});

describe('groupEditions', () => {
  const ed = (id: number, title: string, overrides: Partial<Row> = {}): Row => ({
    id,
    title,
    subtitle: null,
    ...complete({ stockTier: 0 }),
    ...overrides,
  });
  const key = (r: Row) => normalizeWorkText(r.title);

  it('keeps every edition, each work where it first appeared, hardback first within it', () => {
    const rows = [
      ed(1, 'Dune', { productForm: 'BC' }),
      ed(2, 'Emma', { productForm: 'BC' }),
      ed(3, 'The Dune', { productForm: 'BB' }),
      ed(4, 'Dune', { productForm: 'AJ' }),
    ];
    expect(groupEditions(rows, key).map((g) => g.map((r) => r.id))).toEqual([[3, 1, 4], [2]]);
  });

  it('lets an edition on the shelf lead an order-in hardback', () => {
    const rows = [ed(1, 'Dune', { productForm: 'BB', stockTier: 1 }), ed(2, 'Dune', { productForm: 'BC' })];
    expect(groupEditions(rows, key).flat().map((r) => r.id)).toEqual([2, 1]);
  });

  it('keeps relevance order between editions that tie', () => {
    const rows = [ed(1, 'Dune', { productForm: 'BC' }), ed(2, 'Dune', { productForm: 'BC' })];
    expect(groupEditions(rows, key).flat().map((r) => r.id)).toEqual([1, 2]);
  });
});
