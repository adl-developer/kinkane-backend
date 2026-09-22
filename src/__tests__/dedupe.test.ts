import { describe, it, expect } from 'vitest';
import { dedupeByTitle, dedupeByTitleAndSubtitle, type DedupeCandidate } from '../lib/dedupe';

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
// a buyable edition first, then paperback, then hardback, then any other format — and
// only then the content rules above.
describe('edition format preference', () => {
  const ed = (id: number, productForm: string | null, overrides: Partial<Row> = {}): Row => ({
    id,
    title: 'Dune',
    subtitle: null,
    ...complete({ productForm, buyable: true }),
    ...overrides,
  });

  it('shows the paperback when paperback, hardback and other formats all exist', () => {
    const rows = [ed(1, 'AB'), ed(2, 'BB'), ed(3, 'BC')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([3]);
  });

  it('falls back to the hardback when there is no paperback', () => {
    const rows = [ed(1, 'EA'), ed(2, 'BB'), ed(3, 'AB')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('uses any other format when there is neither', () => {
    const rows = [ed(1, 'EA'), ed(2, 'AB')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([1]);
  });

  it('prefers the paperback even over a hardback with a cover and a complete record', () => {
    const rows = [ed(1, 'BB'), ed(2, 'BC', bare({ productForm: 'BC', buyable: true }))];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('prefers a buyable hardback over a paperback that cannot be bought', () => {
    const rows = [ed(1, 'BC', { buyable: false }), ed(2, 'BB')];
    expect(dedupeByTitle(rows).map((r) => r.id)).toEqual([2]);
  });

  it('still prefers the paperback when no edition can be bought', () => {
    const rows = [ed(1, 'BB', { buyable: false }), ed(2, 'BC', { buyable: false })];
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
    const rows = [ed(1, 'BB'), ed(2, ' bc ')];
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
