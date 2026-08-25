import { describe, it, expect } from 'vitest';
import { slugifyName, generateCode } from '../services/referrals.service';

// The link is the product surface here: it gets read aloud, retyped, pasted into
// WhatsApp and clipped by URL detectors. These cover the properties that make it
// survive that — none of which are visible from a passing happy path.

describe('slugifyName', () => {
  it('strips accents rather than dropping the characters', () => {
    // The app is called Kinkané. A slugifier that deletes non-ASCII instead of
    // decomposing it would turn "René" into "ren".
    expect(slugifyName('René Kinkané')).toBe('rene-kinkane');
  });

  it('collapses punctuation and spacing into single hyphens', () => {
    expect(slugifyName("Mary-Jane  O'Brien Jr.")).toBe('mary-jane-o-brien-jr');
  });

  it('never begins or ends with a hyphen', () => {
    // A trailing hyphen would show up in the URL as ".../r/CODE/jason-".
    expect(slugifyName('  !!Jason!!  ')).toBe('jason');
  });

  it('falls back to a word for names with no Latin characters', () => {
    // Chinese, Arabic and emoji-only names legitimately reduce to nothing, and
    // an empty slug would leave the link ending in a bare slash.
    expect(slugifyName('王小明')).toBe('friend');
    expect(slugifyName('🙂')).toBe('friend');
  });

  it('truncates long names without leaving a trailing hyphen', () => {
    const slug = slugifyName('Alexander'.repeat(10));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/-$/);
  });

  it('is stable for the same input', () => {
    // The slug is recomputed every time a link is rendered, so instability would
    // mean the same user's link text changing between screens.
    expect(slugifyName('Jason Appiatu')).toBe(slugifyName('Jason Appiatu'));
  });
});

describe('generateCode', () => {
  it('excludes the characters people misread when retyping a code', () => {
    // I/L/O/U are absent from the alphabet: a code gets read off a screen and
    // typed into a phone far more often than a password does.
    const codes = Array.from({ length: 200 }, () => generateCode());
    expect(codes.join('')).not.toMatch(/[ILOU]/);
  });

  it('produces the requested length', () => {
    expect(generateCode()).toHaveLength(10);
    expect(generateCode(6)).toHaveLength(6);
  });

  it('does not repeat across a large sample', () => {
    // Not a proof of uniqueness — the unique index is that — but a broken
    // generator (a constant seed, a truncated byte range) shows up here
    // immediately.
    const codes = new Set(Array.from({ length: 5000 }, () => generateCode()));
    expect(codes.size).toBe(5000);
  });

  it('uses the whole alphabet rather than a biased slice', () => {
    // Rejection sampling exists so no character is more likely than another; a
    // modulo shortcut would leave the tail of the alphabet underrepresented.
    // 20k characters over a 32-symbol alphabet means every symbol should appear
    // unless something is structurally excluding it.
    const sample = Array.from({ length: 2000 }, () => generateCode()).join('');
    const seen = new Set(sample.split(''));
    expect(seen.size).toBe(32);
  });
});
