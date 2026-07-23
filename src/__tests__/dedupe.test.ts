import { describe, it, expect } from 'vitest';
import { dedupeByTitleAndSubtitle } from '../lib/dedupe';

interface Row {
  id: number;
  title: string;
  subtitle: string | null;
}

describe('dedupeByTitleAndSubtitle', () => {
  it('drops later rows with the same title and subtitle', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null },
      { id: 2, title: 'Dune', subtitle: null },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toEqual([{ id: 1, title: 'Dune', subtitle: null }]);
  });

  it('keeps rows with the same title but different subtitles', () => {
    const rows: Row[] = [
      { id: 1, title: 'Poems', subtitle: 'Collected Works' },
      { id: 2, title: 'Poems', subtitle: 'Selected Works' },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(2);
  });

  it('keeps rows with different titles but the same subtitle', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: 'A Novel' },
      { id: 2, title: 'Shogun', subtitle: 'A Novel' },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(2);
  });

  it('treats null and empty-string subtitles as the same key', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null },
      { id: 2, title: 'Dune', subtitle: '' },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(1);
  });

  it('is case-insensitive and trims whitespace on both fields', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: 'A Novel' },
      { id: 2, title: '  DUNE  ', subtitle: '  a novel  ' },
    ];
    expect(dedupeByTitleAndSubtitle(rows)).toHaveLength(1);
  });

  it('preserves input order, keeping the first occurrence of each key', () => {
    const rows: Row[] = [
      { id: 1, title: 'Dune', subtitle: null },
      { id: 2, title: 'Frank Herbert', subtitle: null },
      { id: 3, title: 'Dune', subtitle: null },
    ];
    expect(dedupeByTitleAndSubtitle(rows).map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeByTitleAndSubtitle([])).toEqual([]);
  });
});
