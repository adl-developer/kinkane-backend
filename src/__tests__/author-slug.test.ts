import { describe, it, expect } from 'vitest';
import { authorSlug, AUTHOR_SLUG_PATTERN } from '../lib/author-slug';

// The slug is the author's identity — there is no authors table — and it has to
// stay character-for-character identical to the SQL expression behind
// idx_book_contributors_author_slug:
//
//   btrim(lower(regexp_replace(person_name, '[^a-zA-Z0-9]+', '-', 'g')), '-')
//
// If the two drift, author pages still work but stop using the index and start
// scanning the contributor table. That is invisible in tests and only shows up
// as production latency, so these cases pin the shared behaviour precisely.

/** A faithful JS transcription of the SQL index expression. */
function sqlEquivalent(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  return replaced.replace(/^-+|-+$/g, '');
}

describe('authorSlug', () => {
  it('handles the ordinary case', () => {
    expect(authorSlug('Tayari Jones')).toBe('tayari-jones');
    expect(authorSlug('Bernardine Evaristo')).toBe('bernardine-evaristo');
  });

  it('collapses punctuation rather than dropping it silently', () => {
    expect(authorSlug('N. K. Jemisin')).toBe('n-k-jemisin');
    expect(authorSlug("O'Brien, Edna")).toBe('o-brien-edna');
    expect(authorSlug('Anne-Marie   Slaughter')).toBe('anne-marie-slaughter');
  });

  it('trims separators from both ends', () => {
    expect(authorSlug('  Rupi Kaur  ')).toBe('rupi-kaur');
    expect(authorSlug('...Maya Angelou!!!')).toBe('maya-angelou');
  });

  it('treats accents as separators, matching what an index can do', () => {
    // Postgres can only fold accents with unaccent(), which is STABLE and so
    // illegal in an index expression. Both sides therefore lose the accent
    // rather than disagreeing about it — a resolvable slug beats a pretty one.
    expect(authorSlug('Adichié')).toBe('adichi');
    expect(authorSlug('Émile Zola')).toBe('mile-zola');
  });

  it('produces something the route will accept, or nothing at all', () => {
    for (const name of ['Tayari Jones', 'N. K. Jemisin', "O'Brien, Edna", '...Maya Angelou!!!']) {
      expect(authorSlug(name)).toMatch(AUTHOR_SLUG_PATTERN);
    }
    // A name with no alphanumerics has no slug; the route rejects '' as a 400
    // rather than resolving it to an arbitrary author.
    expect(authorSlug('---')).toBe('');
    expect(AUTHOR_SLUG_PATTERN.test('')).toBe(false);
  });

  it('matches the SQL index expression exactly', () => {
    const names = [
      'Tayari Jones', 'N. K. Jemisin', "O'Brien, Edna", 'Anne-Marie Slaughter',
      'Adichié', 'Émile Zola', '  Rupi Kaur  ', '...Maya Angelou!!!',
      'J.R.R. Tolkien', 'bell hooks', 'Ngũgĩ wa Thiongo', '2Pac', '---',
    ];
    for (const name of names) expect(authorSlug(name)).toBe(sqlEquivalent(name));
  });

  it('is idempotent — slugging a slug changes nothing', () => {
    // The client may link from a slug it already holds rather than from a name.
    for (const name of ['Tayari Jones', 'N. K. Jemisin']) {
      const once = authorSlug(name);
      expect(authorSlug(once)).toBe(once);
    }
  });
});
