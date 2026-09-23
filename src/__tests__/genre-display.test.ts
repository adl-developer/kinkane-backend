import { describe, it, expect } from 'vitest';
import {
  addDisplayGenre,
  genreDisplayName,
  genreFamilySlug,
  genreIdsForSlug,
  toDisplayGenres,
  toTopLevelGenres,
  type GenreRef,
} from '../lib/genre-display';

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
  it('shows a top level once when several genres share it, under the family slug', () => {
    const genres: GenreRef[] = [
      { name: 'Literary studies: general', slug: 'literary_studies_general' },
      { name: 'Crime and mystery', slug: 'crime_and_mystery' },
      { name: 'Literary studies: poetry and poets', slug: 'literary_studies_poetry_and_poets' },
    ];
    expect(toDisplayGenres(genres)).toEqual([
      { name: 'Literary studies', slug: 'literary_studies' },
      { name: 'Crime and mystery', slug: 'crime_and_mystery' },
    ]);
  });

  it('collapses names that differ only in case', () => {
    const genres: GenreRef[] = [
      { name: 'Fantasy: epic', slug: 'a' },
      { name: 'fantasy', slug: 'b' },
    ];
    expect(toDisplayGenres(genres)).toEqual([{ name: 'Fantasy', slug: 'fantasy' }]);
  });

  it('collapses names that differ only in punctuation, keeping the first spelling', () => {
    const genres: GenreRef[] = [
      { name: 'Children’s / Teenage fiction: Fantasy', slug: 'a' },
      { name: "Children's / Teenage fiction: Humour", slug: 'b' },
    ];
    expect(toDisplayGenres(genres)).toEqual([
      { name: 'Children’s / Teenage fiction', slug: 'childrens__teenage_fiction' },
    ]);
  });

  // Book details cached before this change hold the shortened name with the old
  // sub-genre slug; the re-normalisation on read has to move them to the family.
  it('moves an already-shortened entry onto its family slug', () => {
    expect(toDisplayGenres([{ name: 'Literary studies', slug: 'literary_studies_general' }])).toEqual([
      { name: 'Literary studies', slug: 'literary_studies' },
    ]);
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
    expect(list).toEqual([{ name: 'Gender studies', slug: 'gender_studies' }]);
  });
});

describe('genreFamilySlug', () => {
  it('is the stored slug for a genre with no colon, so that genre stays in its own family', () => {
    // Stored slugs come from the ingester's slugify of the full name.
    expect(genreFamilySlug({ name: 'Crime and mystery', slug: 'crime_and_mystery' })).toBe('crime_and_mystery');
  });

  it('falls back to the stored slug when the top level has nothing slug-safe in it', () => {
    expect(genreFamilySlug({ name: '“”: oddly formed', slug: 'oddly_formed' })).toBe('oddly_formed');
  });
});

describe('toTopLevelGenres', () => {
  const rows = [
    { id: 7, name: 'Crime and mystery', slug: 'crime_and_mystery' },
    { id: 3, name: 'Literary studies', slug: 'literary_studies' },
    { id: 1, name: 'Literary studies: general', slug: 'literary_studies_general' },
    { id: 2, name: 'Literary studies: poetry and poets', slug: 'literary_studies_poetry_and_poets' },
  ];

  it('lists each top level once, with the first row’s id', () => {
    expect(toTopLevelGenres(rows)).toEqual([
      { id: 7, name: 'Crime and mystery', slug: 'crime_and_mystery' },
      { id: 3, name: 'Literary studies', slug: 'literary_studies' },
    ]);
  });

  it('sorts on the shortened name, not the full heading', () => {
    // Full-heading order puts "Educational systems" before "Educational: …".
    const listed = toTopLevelGenres([
      { id: 1, name: 'Educational systems', slug: 'educational_systems' },
      { id: 2, name: 'Educational: Maths', slug: 'educational_maths' },
    ]);
    expect(listed.map((g) => g.name)).toEqual(['Educational', 'Educational systems']);
  });

  it('does not change the rows it was given', () => {
    const copy = structuredClone(rows);
    toTopLevelGenres(rows);
    expect(rows).toEqual(copy);
  });
});

describe('genreIdsForSlug', () => {
  const rows = [
    { id: 1, name: 'Literary studies: general', slug: 'literary_studies_general' },
    { id: 2, name: 'Literary studies: poetry and poets', slug: 'literary_studies_poetry_and_poets' },
    { id: 3, name: 'Literary studies', slug: 'literary_studies' },
    { id: 4, name: 'Literary theory', slug: 'literary_theory' },
  ];

  it('expands a family slug to every genre under that top level', () => {
    expect(genreIdsForSlug(rows, 'literary_studies')).toEqual([1, 2, 3]);
  });

  it('keeps an old full slug filtering to exactly that genre', () => {
    expect(genreIdsForSlug(rows, 'literary_studies_poetry_and_poets')).toEqual([2]);
  });

  it('does not treat a slug as a prefix', () => {
    expect(genreIdsForSlug(rows, 'literary')).toEqual([]);
  });
});
