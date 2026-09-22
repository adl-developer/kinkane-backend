import { describe, it, expect } from 'vitest';
import { addDisplayGenre, genreDisplayName, toDisplayGenres, type GenreRef } from '../lib/genre-display';

describe('genreDisplayName', () => {
  it('keeps only the part before the colon', () => {
    expect(genreDisplayName('Literary studies: poetry and poets')).toBe('Literary studies');
  });

  it('keeps only the part before the first colon when there are several', () => {
    expect(genreDisplayName('Children’s / Teenage general interest: Ball games and sports: Cricket')).toBe(
      'Children’s / Teenage general interest',
    );
  });

  it('leaves a name with no colon alone, apart from trimming', () => {
    expect(genreDisplayName('Crime and mystery')).toBe('Crime and mystery');
    expect(genreDisplayName('  Crime and mystery  ')).toBe('Crime and mystery');
  });

  it('never returns an empty name', () => {
    expect(genreDisplayName(': oddly formed')).toBe(': oddly formed');
  });
});

describe('toDisplayGenres', () => {
  it('shows a top level once when several genres share it, keeping the first slug', () => {
    const genres: GenreRef[] = [
      { name: 'Literary studies: general', slug: 'literary_studies_general' },
      { name: 'Crime and mystery', slug: 'crime_and_mystery' },
      { name: 'Literary studies: poetry and poets', slug: 'literary_studies_poetry_and_poets' },
    ];
    expect(toDisplayGenres(genres)).toEqual([
      { name: 'Literary studies', slug: 'literary_studies_general' },
      { name: 'Crime and mystery', slug: 'crime_and_mystery' },
    ]);
  });

  it('collapses names that differ only in case', () => {
    const genres: GenreRef[] = [
      { name: 'Fantasy: epic', slug: 'a' },
      { name: 'fantasy', slug: 'b' },
    ];
    expect(toDisplayGenres(genres)).toEqual([{ name: 'Fantasy', slug: 'a' }]);
  });

  // Book pages are re-normalised on every read so older cached copies are
  // corrected; that is only safe if a second pass changes nothing.
  it('is idempotent', () => {
    const once = toDisplayGenres([
      { name: 'Literary studies: general', slug: 'x' },
      { name: 'Literary studies: poetry', slug: 'y' },
    ]);
    expect(toDisplayGenres(once)).toEqual(once);
  });
});

describe('addDisplayGenre', () => {
  it('appends in display form and skips a name already shown', () => {
    const list: GenreRef[] = [];
    addDisplayGenre(list, { name: 'Gender studies: women and girls', slug: 'g1' });
    addDisplayGenre(list, { name: 'Gender studies: men and boys', slug: 'g2' });
    expect(list).toEqual([{ name: 'Gender studies', slug: 'g1' }]);
  });
});
