import { describe, it, expect } from 'vitest';
import { escapeLike, likePrefix, likeWordPrefix, likeContains, apostropheVariants } from '../lib/escape-like';

// The patterns every search builds from typed text. Only the `%` each helper
// adds is a wildcard; whatever was typed matches literally, except an apostrophe
// inside a word, which matches any apostrophe.

describe('LIKE pattern helpers', () => {
  it('escapes the metacharacters, backslash first so it is not doubled twice', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });

  it('builds escaped prefix, word-prefix and contains patterns', () => {
    expect(likePrefix('100%')).toBe('100\\%%');
    expect(likeWordPrefix('a_b')).toBe('% a\\_b%');
    expect(likeContains('%%')).toBe('%\\%\\%%');
  });

  it('leaves ordinary text alone', () => {
    expect(likePrefix('Hunt')).toBe('Hunt%');
    expect(likeWordPrefix('Hunt')).toBe('% Hunt%');
    expect(likeContains('Hunt')).toBe('%Hunt%');
  });
});

// iOS Smart Punctuation sends ’ when someone types ', and the catalogue stores both, so a
// word-internal apostrophe has to match either one.
describe('apostrophes in search patterns', () => {
  it('turns an apostrophe after a letter into a one-character wildcard, whichever was typed', () => {
    expect(likeWordPrefix("baba segi's")).toBe('% baba segi_s%');
    expect(likeWordPrefix('baba segi’s')).toBe('% baba segi_s%');
    expect(likePrefix('O‘Brien')).toBe('O_Brien%');
    expect(likeContains('Thiongʼo')).toBe('%Thiong_o%');
  });

  it('keeps a trailing apostrophe literal, so "the’" does not mean "the" plus any character', () => {
    expect(likePrefix('baba segi’')).toBe("baba segi'%");
    expect(likePrefix('the’')).toBe("the'%");
  });

  it('wildcards an apostrophe after a combining mark (decomposed text)', () => {
    expect(likePrefix('Ngi\u0303\u2019s')).toBe('Ngi\u0303_s%');
  });

  it('keeps an apostrophe that opens a word, or stands alone, literal — never match-everything', () => {
    expect(likePrefix("'")).toBe("'%");
    expect(likePrefix('’')).toBe("'%");
    expect(likeWordPrefix('‘tis')).toBe("% 'tis%");
  });

  it('still escapes a typed underscore next to an apostrophe', () => {
    expect(likePrefix("a_'b")).toBe("a\\_'b%");
  });
});

describe('apostropheVariants', () => {
  it('spells the query with both apostrophes', () => {
    expect(apostropheVariants('baba segi’s')).toEqual(["baba segi's", 'baba segi’s']);
    expect(apostropheVariants("baba segi's")).toEqual(["baba segi's", 'baba segi’s']);
  });

  it('returns a query without one unchanged', () => {
    expect(apostropheVariants('baba segi')).toEqual(['baba segi']);
  });
});
