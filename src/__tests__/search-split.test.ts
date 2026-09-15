import { describe, it, expect } from 'vitest';
import { splitCandidates } from '../lib/search-split';

/**
 * Candidate generation for the split search band.
 *
 * This half is pure and cheap, and its job is not to be right — the probe decides which
 * candidate wins by scoring each one against the catalogue. Its job is to be *bounded* and
 * to not throw away the reading that turns out to be correct. So the guards here are about
 * width and coverage rather than about which candidate comes first.
 */

const names = (q: string): string[] => splitCandidates(q).map((c) => c.name);

describe('splitCandidates', () => {
  // The searches that already work must cost nothing. A one-word query is answered whole by
  // both the title and the name tiers, and an empty candidate list is what keeps it off the
  // probe entirely.
  it('proposes nothing for a query that cannot usefully split', () => {
    expect(splitCandidates('chimamanda')).toEqual([]);
    expect(splitCandidates('')).toEqual([]);
    expect(splitCandidates('   ')).toEqual([]);
  });

  // Long queries are either a full title, which the title tiers answer, or pasted text.
  // Neither benefits, and both would widen the probe for nothing.
  it('proposes nothing for a query long enough to be a title already', () => {
    expect(splitCandidates('one two three four five six seven eight nine')).toEqual([]);
  });

  it('offers the name run from both ends', () => {
    const found = names('yellow sun adichie');
    expect(found).toContain('adichie');
    expect(found).toContain('yellow');
  });

  // The reading that matters for "half of a yellow sun adichie" is the trailing one-token
  // run. For "chimamanda ngozi adichie half of a yellow sun" it is the leading three-token
  // run. Both have to survive generation, since the probe can only score what it is given.
  it('keeps the full name run when the name leads', () => {
    const candidate = splitCandidates('chimamanda ngozi adichie half of').find(
      (c) => c.name === 'chimamanda ngozi adichie',
    );
    expect(candidate).toBeDefined();
    expect(candidate!.titleTokens).toEqual(['half', 'of']);
    expect(candidate!.position).toBe('leading');
  });

  it('keeps the full name run when the name trails', () => {
    const candidate = splitCandidates('things fall apart chinua achebe').find(
      (c) => c.name === 'chinua achebe',
    );
    expect(candidate).toBeDefined();
    expect(candidate!.titleTokens).toEqual(['things', 'fall', 'apart']);
    expect(candidate!.position).toBe('trailing');
  });

  // Every candidate costs two index arms in the probe, and the arms are what bound its cost.
  it('never proposes more candidates than the probe is sized for', () => {
    for (const q of [
      'harry potter rowling',
      'half of a yellow sun chimamanda ngozi adichie',
      'one two three four five six seven eight',
    ]) {
      expect(splitCandidates(q).length, q).toBeLessThanOrEqual(6);
    }
  });

  // A candidate with no title tokens left is not a split — it is the plain author search the
  // name tiers already ran and the exact band already ruled out. It would also divide by zero
  // in the probe's score.
  it('always leaves at least one word for the title', () => {
    for (const q of ['harry potter rowling', 'a b c d', 'things fall apart chinua achebe']) {
      for (const candidate of splitCandidates(q)) {
        expect(candidate.titleTokens.length, `${q} / ${candidate.name}`).toBeGreaterThan(0);
      }
    }
  });

  // As a *prefix* match a one- or two-letter token is close to unbounded: "j" begins a large
  // slice of the contributor table. Inside a longer run it is fine, because the later tokens
  // bound it — which is what keeps "j k rowling" reachable.
  it('will not propose a bare initial as a name on its own', () => {
    expect(names('emma j')).not.toContain('j');
    expect(names('j k rowling emma')).toContain('j k rowling');
  });

  // Otherwise every query containing "the" or "of" spends an arm dragging in whichever
  // contributors happen to have names starting that way.
  it('will not propose a lone stopword as a name', () => {
    expect(names('the alchemist')).not.toContain('the');
    expect(names('lord of the rings')).not.toContain('the');
  });

  // The complement of the rule above, and the reason it is worded as "entirely stopwords":
  // real names contain small words, and dropping any run holding one would put "wa" out of
  // reach in "ngugi wa thiong'o".
  it('keeps a multi-word run that contains a stopword', () => {
    expect(names('the river between ngugi wa thiong')).toContain('ngugi wa thiong');
  });

  // Two arms per candidate, so a duplicate is a doubled cost for a guaranteed-identical
  // result.
  it('proposes no duplicate readings', () => {
    for (const q of ['sun sun adichie', 'harry potter rowling', 'a a a b']) {
      const keys = splitCandidates(q).map((c) => `${c.name}|${c.titleTokens.join(' ')}`);
      expect(new Set(keys).size, q).toBe(keys.length);
    }
  });

  // Contributor names arrive from the feed with doubled internal spaces on about a fifth of
  // rows, so the query side is normalised before it is compared. Tokenising has to survive
  // the same thing arriving from a reader.
  it('tolerates irregular whitespace', () => {
    expect(names('  things   fall  apart   achebe ')).toContain('achebe');
  });
});

describe('splitCandidates title words', () => {
  // `title ILIKE '%a%'` is true for almost the whole catalogue, so counting it as evidence
  // would give every book by the right author the same score and hand the ranking to the
  // alphabet. Dropping it is what lets "Half of a Yellow Sun" score 3 of 3 while an
  // unrelated book by the same author scores nothing and is excluded from the band.
  it('ignores stopwords and single letters when matching a title', () => {
    const candidate = splitCandidates('half of a yellow sun adichie').find(
      (c) => c.name === 'adichie',
    );
    expect(candidate).toBeDefined();
    expect(candidate!.titleTokens).toEqual(['half', 'of', 'a', 'yellow', 'sun']);
    expect(candidate!.titleMatchTokens).toEqual(['half', 'yellow', 'sun']);
  });

  // Weak evidence still beats none: an empty list would score every candidate zero, and the
  // band discards anything that scores zero.
  it('keeps the words it has when they are all stopwords', () => {
    const candidate = splitCandidates('of the achebe').find((c) => c.name === 'achebe');
    expect(candidate).toBeDefined();
    expect(candidate!.titleMatchTokens).toEqual(['of', 'the']);
  });
});
