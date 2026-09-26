import { describe, it, expect } from 'vitest';
import { attributableContributor, bioMentions, plainText, surnameOf } from '../lib/author-bio-match';

/**
 * The biographies quoted here are real BDS values, trimmed — including the
 * three-editor blob that is exactly why a book-level biography is not pinned
 * to the first contributor.
 */

const SELINA = '<p>Selina Brown is an Author, Marketing Consultant and Event Producer. At 16 she became the Youth MP for Nottingham...</p>';
const THREE_EDITORS =
  '<p>Kanupriya Agarwal, MD is a physician, researcher and entrepreneur...</p>' +
  '<p>As Chief Innovation Officer at Sama Therapeutics, Russell Hanson leads iMAGiNE...</p>';

const author = (personName: string) => ({ role: 'A01', personName });

describe('plainText', () => {
  it('strips markup and entities and folds accents', () => {
    expect(plainText('<p>Emily Bront&euml;<br />is <b>here</b></p>')).toBe('emily bront is here');
    expect(plainText('Gabriel García Márquez')).toBe('gabriel garcia marquez');
  });
});

describe('surnameOf', () => {
  it('takes the last word of the name', () => {
    expect(surnameOf('Selina Brown')).toBe('brown');
  });

  it('ignores honorific and generational suffixes', () => {
    expect(surnameOf('Martin Luther King Jr.')).toBe('king');
    expect(surnameOf('Henry Ford III')).toBe('ford');
    expect(surnameOf('Kanupriya Agarwal, MD')).toBe('agarwal');
  });

  it('refuses a token too short to be evidence', () => {
    // A two-letter "surname" matches inside ordinary words, which would make
    // the whole check meaningless.
    expect(surnameOf('Jay Z')).toBeNull();
    expect(surnameOf('')).toBeNull();
  });
});

describe('bioMentions', () => {
  it('matches the surname in real biography text', () => {
    expect(bioMentions(SELINA, 'Selina Brown')).toBe(true);
  });

  it('does not match a different person', () => {
    expect(bioMentions(SELINA, 'David Peace')).toBe(false);
  });

  it('matches on whole words only', () => {
    // "Ford" must not match inside "Stafford" — that is how a biography ends
    // up on the wrong author's book.
    expect(bioMentions('<p>Anne Stafford writes about canals.</p>', 'Henry Ford')).toBe(false);
  });

  it('matches across a spelling that differs only by accent', () => {
    expect(bioMentions('<p>Emily Bronte was born in Thornton.</p>', 'Emily Brontë')).toBe(true);
  });

  it('copes with a name containing regex characters', () => {
    expect(bioMentions("<p>Flann O'Brien was a novelist.</p>", "Flann O'Brien")).toBe(true);
  });

  it('tolerates the doubled internal spaces the feeds send', () => {
    expect(bioMentions('<p>David Peace is a novelist.</p>', 'David  Peace')).toBe(true);
  });
});

describe('attributableContributor', () => {
  it('attributes a biography to the one author it names', () => {
    const result = attributableContributor([author('Selina Brown')], SELINA);
    expect(result?.contributor.personName).toBe('Selina Brown');
    expect(result?.confidence).toBe('high');
  });

  it('refuses when the book has several authors', () => {
    expect(attributableContributor([author('Selina Brown'), author('David Peace')], SELINA)).toBeNull();
  });

  it('refuses when the biography is about somebody else', () => {
    // 6% of single-author books, measured — the blob describes a different
    // person, and this is the check that catches it.
    expect(attributableContributor([author('David Peace')], SELINA)).toBeNull();
  });

  it('refuses the three-editor blob, which names nobody in an author role', () => {
    const editors = [
      { role: 'B01', personName: 'Arnaud Bernaert' },
      { role: 'B01', personName: 'Kanupriya Agarwal' },
      { role: 'B01', personName: 'Russell Hanson' },
    ];
    expect(attributableContributor(editors, THREE_EDITORS)).toBeNull();
  });

  it('ignores non-author contributors when counting authors', () => {
    const contributors = [author('Selina Brown'), { role: 'A12', personName: 'An Illustrator' }];
    expect(attributableContributor(contributors, SELINA)?.contributor.personName).toBe('Selina Brown');
  });

  it('refuses a biography that also covers another contributor', () => {
    // Real shape, from a manga: one blob describing the creator and the
    // illustrator. Pinned to the creator it would show the illustrator's life
    // story under her name.
    const shared =
      '<b>Punichan</b> is a manga creator in Japan...<br><br><b>Yuu Takaoka</b> is a manga creator in Japan.';
    const contributors = [author('Punichan'), { role: 'A12', personName: 'Yuu Takaoka' }];
    expect(attributableContributor(contributors, shared)).toBeNull();
  });

  it('returns null when there is no biography at all', () => {
    expect(attributableContributor([author('Selina Brown')], null)).toBeNull();
  });
});
