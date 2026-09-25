import { describe, it, expect } from 'vitest';
import { bioSimilarity, mergeCandidates, normaliseAuthorName, samePerson, significantWords } from '../services/author-bios.service';

/**
 * The two biographies of John Patrick Green are real, and are the reason the
 * similarity threshold is what it is: one person, reworded by the publisher
 * between editions, scoring 0.30. Unrelated biographies score under 0.04.
 */
const GREEN_A =
  'John Patrick Green lives and works in New York City where he makes books and comics about animals with human jobs, notably the smash-hit graphic novel series InvestiGators.';
const GREEN_B =
  'John Patrick Green is a human with the human job of making books about animals with human jobs, notably the smash-hit graphic novel series InvestiGators.';
const UNRELATED =
  'Habib Borjian is a linguist with expertise on historical linguistics, language documentation, philology, dialectology and Iranian languages.';

const candidate = (bioHtml: string, pubDate: string | null, displayName = 'John Patrick Green') => ({
  normalisedName: normaliseAuthorName(displayName),
  displayName,
  bioHtml,
  isbn13: '9780000000001',
  pubDate,
  sourceUpdated: null,
});

describe('normaliseAuthorName', () => {
  it('collapses the doubled spaces the feeds send, and lowercases', () => {
    expect(normaliseAuthorName('David  Peace ')).toBe('david peace');
  });
});

describe('significantWords', () => {
  it('drops markup, short words and filler', () => {
    const words = significantWords('<p>She has written a <b>book</b> about volcanoes.</p>');
    expect(words.has('volcanoes')).toBe(true);
    expect(words.has('book')).toBe(false); // too common to be evidence
    expect(words.has('she')).toBe(false); // too short
  });
});

describe('bioSimilarity', () => {
  it('scores the same person, reworded, well above unrelated people', () => {
    const same = bioSimilarity(GREEN_A, GREEN_B);
    const different = bioSimilarity(GREEN_A, UNRELATED);
    expect(same).toBeGreaterThan(0.25);
    expect(different).toBeLessThan(0.05);
    expect(same).toBeGreaterThan(different * 5);
  });

  it('is 1 for identical text and 0 when one side is empty', () => {
    expect(bioSimilarity(GREEN_A, GREEN_A)).toBe(1);
    expect(bioSimilarity(GREEN_A, '')).toBe(0);
  });
});

describe('samePerson', () => {
  it('accepts a publisher rewording', () => {
    expect(samePerson(GREEN_A, GREEN_B)).toBe(true);
  });

  it('rejects two different people', () => {
    expect(samePerson(GREEN_A, UNRELATED)).toBe(false);
  });
});

describe('mergeCandidates', () => {
  it('keeps the biography from the most recently published book', () => {
    const merged = mergeCandidates([candidate(GREEN_A, '2019-01-01'), candidate(GREEN_B, '2024-06-01')]);
    expect(merged.chosen.bioHtml).toBe(GREEN_B);
    expect(merged.confidence).toBe('high');
    expect(merged.booksConsidered).toBe(2);
  });

  it('marks a name ambiguous when its books describe different people', () => {
    // One name, two lives — a real collision. Nothing is served for this
    // author, though each book still shows the biography it came with.
    const merged = mergeCandidates([candidate(GREEN_A, '2024-01-01'), candidate(UNRELATED, '2020-01-01')]);
    expect(merged.confidence).toBe('ambiguous');
  });

  it('treats a single book as high confidence', () => {
    expect(mergeCandidates([candidate(GREEN_A, '2024-01-01')]).confidence).toBe('high');
  });

  it('sorts undated books last rather than letting them win', () => {
    const merged = mergeCandidates([candidate(GREEN_B, null), candidate(GREEN_A, '2001-01-01')]);
    expect(merged.chosen.bioHtml).toBe(GREEN_A);
  });
});
