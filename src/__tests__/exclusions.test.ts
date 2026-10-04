import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildHasAuthorCondition,
  buildWorkExclusionCondition,
  filterExcludedWorks,
  hasNamedAuthor,
  normalizeAuthorForMatch,
  normalizeForMatch,
  normalizeTitleForMatch,
  titleKeysForMatch,
  type UserExclusions,
} from '../lib/exclusions';

// These cover the two encodings of one rule: "don't show this user a book they
// already told us about". One runs in SQL (quiz results, personalized feed,
// recommendation emails), one in memory (the shared "you may also like"
// cache). They have to agree — a book excluded from one surface and not the
// other is the exact bug this is meant to prevent.

const dialect = new PgDialect();

function compile(sql: ReturnType<typeof buildWorkExclusionCondition>) {
  if (!sql) throw new Error('expected a condition');
  return dialect.sqlToQuery(sql);
}

function item(
  id: number,
  title: string,
  authors: string[] = [],
  role = 'A01',
): { id: number; title: string; contributors: { role: string | null; personName: string | null }[] } {
  return {
    id,
    title,
    contributors: authors.map((personName) => ({ role, personName })),
  };
}

function exclusions(partial: Partial<UserExclusions>): UserExclusions {
  return { bookIds: [], works: [], ...partial };
}

describe('normalizeForMatch', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(normalizeForMatch('  The Silent Patient ')).toBe('the silent patient');
  });
});

describe('normalizeTitleForMatch', () => {
  it.each([
    ["The Secret Lives of Baba Segi's Wives", 'secret lives of baba segi s wives'],
    ["Secret Lives of Baba Segi's Wives", 'secret lives of baba segi s wives'],
    ["Secret Lives of Baba Segi's Wives, The", 'secret lives of baba segi s wives'],
    ['A Return to Love', 'return to love'],
    ['Bridget & Gabe', 'bridget and gabe'],
    ['  Things  Fall   Apart. ', 'things fall apart'],
    // No unaccent in the database, so the SQL twin cannot strip accents.
    ['Les Misérables', 'les misérables'],
    // Superscripts are not [[:alnum:]] under ICU, so they must not be here either.
    ['[¹8F]FDG PET/CT', '8f fdg pet ct'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTitleForMatch(input)).toBe(expected);
  });

  it('accepts a stored normalizeForMatch snapshot and lands on the same key', () => {
    const raw = "The Secret Lives of Baba Segi's Wives";
    expect(normalizeTitleForMatch(normalizeForMatch(raw))).toBe(normalizeTitleForMatch(raw));
  });

  it('is idempotent', () => {
    const once = normalizeTitleForMatch('Hobbit, The');
    expect(normalizeTitleForMatch(once)).toBe(once);
  });
});

describe('normalizeAuthorForMatch', () => {
  it.each([
    ['Ann Patchett', 'ann patchett'],
    ['Patchett, Ann', 'ann patchett'],
    ['  PATCHETT ,  Ann ', 'ann patchett'],
    // About one catalogue author name in five carries a doubled space.
    ['Robert  Toft', 'robert toft'],
    ['A. S. Byatt', 'a s byatt'],
    ['A S Byatt', 'a s byatt'],
    ['Durand,\tÉlodie', 'élodie durand'],
    // A suffix after the comma is not a first name.
    ['Martin Luther King, Jr.', 'martin luther king, jr'],
    ['Smith, III', 'smith, iii'],
    // More than one comma: no telling which part is the surname, so no flip.
    ['X, Y, Z', 'x, y, z'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeAuthorForMatch(input)).toBe(expected);
  });

  it('is idempotent and accepts a stored normalizeForMatch snapshot', () => {
    const once = normalizeAuthorForMatch('Patchett, Ann');
    expect(normalizeAuthorForMatch(once)).toBe(once);
    expect(normalizeAuthorForMatch(normalizeForMatch('  A. S.  Byatt '))).toBe('a s byatt');
  });
});

describe('titleKeysForMatch', () => {
  it.each([
    ['Bel Canto', '#bel canto', '#bel canto'],
    ['Bel Canto: A Novel', '#bel canto a novel', '#bel canto'],
    ['Bel Canto (Harper Perennial Modern Classics)', '#bel canto', '#bel canto'],
    ['Bel Canto [Large Print]', '#bel canto', '#bel canto'],
    ['Bel Canto - 20th Anniversary Edition', '#bel canto 20th anniversary edition', '#bel canto'],
    // Volume numbers survive the brackets being ignored, and lose leading zeros.
    ['Tokyo Ghoul (Vol. 3)', '3#tokyo ghoul', '3#tokyo ghoul'],
    ['Tokyo Ghoul (Vol. 03)', '3#tokyo ghoul', '3#tokyo ghoul'],
    ['Les Misérables: Tome II', 'ii#les misérables tome ii', 'ii#les misérables'],
    // No space after the colon, so not a subtitle.
    ['Re:ZERO', '#re zero', '#re zero'],
    // A bracket that opens the title is part of it.
    ['(Un)Natural', '#un natural', '#un natural'],
    // A year is not a volume; a lone "I" is not a numeral.
    ['Devon 2026 Calendar', '#devon 2026 calendar', '#devon 2026 calendar'],
    ['The King and I', '#king and i', '#king and i'],
  ])('%s', (input, full, core) => {
    expect(titleKeysForMatch(input)).toEqual({ full, core });
  });

  it('keys every title the plain fold would have matched identically', () => {
    for (const [a, b] of [
      ['The Hobbit', 'Hobbit, The'],
      ['Bridget & Gabe', 'Bridget and Gabe'],
    ]) {
      expect(normalizeTitleForMatch(a)).toBe(normalizeTitleForMatch(b));
      expect(titleKeysForMatch(a)).toEqual(titleKeysForMatch(b));
    }
  });
});

describe('buildWorkExclusionCondition', () => {
  it('folds a leading article out of the excluded title, matching the SQL fold', () => {
    const { sql, params } = compile(
      buildWorkExclusionCondition([{ title: "the secret lives of baba segi's wives", author: null }]),
    );
    expect(params).toContain('#secret lives of baba segi s wives');
    expect(sql).toContain('und-x-icu');
  });

  it('returns undefined for an empty list so callers can spread it', () => {
    expect(buildWorkExclusionCondition([])).toBeUndefined();
  });

  it('normalizes both title and author into the parameters', () => {
    const { params } = compile(
      buildWorkExclusionCondition([{ title: '  Dune ', author: 'Frank HERBERT' }]),
    );
    expect(params).toContain('#dune');
    expect(params).toContain('frank herbert');
  });

  it('passes a null author through rather than dropping the work', () => {
    const { params } = compile(buildWorkExclusionCondition([{ title: 'Dune', author: null }]));
    expect(params).toContain('#dune');
    expect(params).toContain(null);
  });

  it('emits one VALUES row per work, so the plan does not grow a clause per book', () => {
    // The invariant is that the query *shape* is constant: one rejection and a
    // hundred produce the same subquery structure, differing only in how many
    // rows the VALUES list carries.
    const one = compile(buildWorkExclusionCondition([{ title: 'a', author: 'x' }])).sql;
    const many = compile(
      buildWorkExclusionCondition([
        { title: 'a', author: 'x' },
        { title: 'b', author: 'y' },
        { title: 'c', author: 'z' },
      ]),
    ).sql;

    expect(many.match(/NOT EXISTS/g)).toHaveLength(one.match(/NOT EXISTS/g)!.length);
    expect(many.match(/EXISTS/g)).toHaveLength(one.match(/EXISTS/g)!.length);
  });

  it('lets an untagged catalogue row be excluded on title alone', () => {
    // Without this branch, a same-titled book that simply has no A01
    // contributor slips past an author-qualified rejection.
    const { sql } = compile(buildWorkExclusionCondition([{ title: 'dune', author: 'frank herbert' }]));
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("bc.role = 'A01'");
  });
});

describe('buildHasAuthorCondition', () => {
  it('requires a named A01 contributor', () => {
    const { sql } = compile(buildHasAuthorCondition());
    expect(sql).toContain("bc.role = 'A01'");
    expect(sql).toContain('bc.person_name IS NOT NULL');
  });

  it('does not treat a blank name as an author', () => {
    const { sql } = compile(buildHasAuthorCondition());
    expect(sql).toContain('btrim(bc.person_name)');
  });
});

describe('filterExcludedWorks', () => {
  it('drops a book excluded by ID', () => {
    const kept = filterExcludedWorks(
      [item(1, 'Dune', ['Frank Herbert']), item(2, 'Neuromancer', ['William Gibson'])],
      exclusions({ bookIds: [1] }),
    );
    expect(kept.map((b) => b.id)).toEqual([2]);
  });

  it('drops a different edition — same title and author, different ID', () => {
    const kept = filterExcludedWorks(
      [item(99, 'DUNE', ['Frank Herbert'])],
      exclusions({ bookIds: [1], works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept).toHaveLength(0);
  });

  it('drops "The X" when "X" was picked, and the reverse', () => {
    const books = [
      item(1, "The Secret Lives of Baba Segi's Wives", ['Lola Shoneyin']),
      item(2, "Secret Lives of Baba Segi's Wives", ['Lola Shoneyin']),
    ];
    const pickedPlain = exclusions({ works: [{ title: "secret lives of baba segi's wives", author: 'lola shoneyin' }] });
    const pickedThe = exclusions({ works: [{ title: "the secret lives of baba segi's wives", author: 'lola shoneyin' }] });
    expect(filterExcludedWorks(books, pickedPlain)).toHaveLength(0);
    expect(filterExcludedWorks(books, pickedThe)).toHaveLength(0);
  });

  it('keeps a same-titled book by a different author', () => {
    const kept = filterExcludedWorks(
      [item(99, 'Dune', ['Someone Else'])],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept.map((b) => b.id)).toEqual([99]);
  });

  it('falls back to title-only when the rejection has no author recorded', () => {
    const kept = filterExcludedWorks(
      [item(99, 'Dune', ['Anyone At All'])],
      exclusions({ works: [{ title: 'dune', author: null }] }),
    );
    expect(kept).toHaveLength(0);
  });

  it('only considers primary (A01) authors, not translators or editors', () => {
    // A translator credit is not an author credit, so this row counts as
    // having no author at all — which means the title match stands and the
    // book is dropped. (It is not kept on the strength of the B06 name
    // happening to equal the rejected author.)
    const kept = filterExcludedWorks(
      [item(99, 'Dune', ['Frank Herbert'], 'B06')],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept).toHaveLength(0);
  });

  it('drops a same-titled book that has no author recorded at all', () => {
    const kept = filterExcludedWorks(
      [item(99, 'Dune', [])],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept).toHaveLength(0);
  });

  it('still keeps an unrelated book with no author recorded', () => {
    // The looser branch only fires on a title match — it is not a blanket
    // "drop everything untagged" rule.
    const kept = filterExcludedWorks(
      [item(99, 'Neuromancer', [])],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept.map((b) => b.id)).toEqual([99]);
  });

  it('treats a blank contributor name as no author at all', () => {
    // The SQL twin tests btrim(person_name) <> '', so a contributor row
    // carrying an empty name must count as untagged here too — otherwise the
    // same book is dropped from one surface and served on the next.
    const kept = filterExcludedWorks(
      [{ id: 99, title: 'Dune', contributors: [{ role: 'A01', personName: '' }] }],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept).toHaveLength(0);
  });

  it('treats a whitespace-only contributor name as no author at all', () => {
    const kept = filterExcludedWorks(
      [{ id: 99, title: 'Dune', contributors: [{ role: 'A01', personName: '   ' }] }],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept).toHaveLength(0);
  });

  describe('a book the user said they have read: Bel Canto by Ann Patchett', () => {
    const read = exclusions({ works: [{ title: 'bel canto', author: 'ann patchett' }] });
    const keptIds = (items: ReturnType<typeof item>[]) =>
      filterExcludedWorks(items, read).map((b) => b.id);

    it.each([
      'Bel Canto',
      'BEL CANTO',
      'Bel Canto, The',
      'Bel Canto: A Novel',
      'Bel Canto (Harper Perennial Modern Classics)',
      'Bel Canto [Large Print]',
      'Bel Canto - 20th Anniversary Edition',
    ])('drops the edition "%s"', (title) => {
      expect(keptIds([item(1, title, ['Ann Patchett'])])).toEqual([]);
    });

    it('drops an edition whose author is spelled differently', () => {
      expect(
        keptIds([
          item(1, 'Bel Canto', ['Patchett, Ann']),
          item(2, 'Bel Canto', ['Ann  Patchett']),
          item(3, 'Bel Canto', ['ANN PATCHETT']),
        ]),
      ).toEqual([]);
    });

    it("keeps her other books — only a matching title is dropped", () => {
      expect(
        keptIds([
          item(1, 'Whistler', ['Ann Patchett']),
          item(2, "The Magician's Assistant", ['Ann Patchett']),
        ]),
      ).toEqual([1, 2]);
    });

    it('keeps a different book with the same title by someone else', () => {
      // Robert Toft's singing guide is in the catalogue under this exact title.
      expect(keptIds([item(1, 'Bel Canto', ['Robert  Toft'])])).toEqual([1]);
    });

    it('keeps titles that merely start the same way', () => {
      expect(
        keptIds([
          item(1, 'Bel Canto Arias for Soprano', ['Ann Patchett']),
          item(2, 'Canto', ['Ann Patchett']),
        ]),
      ).toEqual([1, 2]);
    });
  });

  it('cuts a subtitle on one side only, so books in one series stay apart', () => {
    // A core-to-core match would merge every "Warriors: …" title.
    const kept = filterExcludedWorks(
      [item(1, 'Warriors: Fading Echoes', ['Erin Hunter']), item(2, 'Warriors', ['Erin Hunter'])],
      exclusions({ works: [{ title: "warriors: a warrior's choice", author: 'erin hunter' }] }),
    );
    expect(kept.map((b) => b.id)).toEqual([1]);
  });

  it('keeps a different volume even when the volume is in brackets', () => {
    const kept = filterExcludedWorks(
      [
        item(1, 'Tokyo Ghoul (Vol. 9)', ['Sui Ishida']),
        item(2, 'Tokyo Ghoul (Vol. 3) (Deluxe)', ['Sui Ishida']),
      ],
      exclusions({ works: [{ title: 'tokyo ghoul (vol. 3)', author: 'sui ishida' }] }),
    );
    expect(kept.map((b) => b.id)).toEqual([1]);
  });

  it("keeps Dracula's Guest when Dracula was read", () => {
    const kept = filterExcludedWorks(
      [item(1, "Dracula's Guest", ['Bram Stoker'])],
      exclusions({ works: [{ title: 'dracula', author: 'bram stoker' }] }),
    );
    expect(kept.map((b) => b.id)).toEqual([1]);
  });

  it('drops an edition credited to only one of several authors', () => {
    // likedBooksToWorks emits one work per author for exactly this case.
    const kept = filterExcludedWorks(
      [item(1, 'Good Omens', ['Neil Gaiman'])],
      exclusions({
        works: [
          { title: 'good omens', author: 'terry pratchett' },
          { title: 'good omens', author: 'neil gaiman' },
        ],
      }),
    );
    expect(kept).toHaveLength(0);
  });

  it('returns the list untouched when the user has rejected nothing', () => {
    const items = [item(1, 'Dune', ['Frank Herbert'])];
    expect(filterExcludedWorks(items, exclusions({}))).toBe(items);
  });
});

describe('hasNamedAuthor', () => {
  it('accepts a named primary author', () => {
    expect(hasNamedAuthor([{ role: 'A01', personName: 'Frank Herbert' }])).toBe(true);
  });

  it('rejects a blank or whitespace-only name', () => {
    expect(hasNamedAuthor([{ role: 'A01', personName: '' }])).toBe(false);
    expect(hasNamedAuthor([{ role: 'A01', personName: '   ' }])).toBe(false);
    expect(hasNamedAuthor([{ role: 'A01', personName: null }])).toBe(false);
  });

  it('does not count a translator as an author', () => {
    expect(hasNamedAuthor([{ role: 'B06', personName: 'Frank Herbert' }])).toBe(false);
  });

  it('accepts a book whose named author sits behind a nameless one', () => {
    expect(
      hasNamedAuthor([
        { role: 'A01', personName: null },
        { role: 'A01', personName: 'Chinua Achebe' },
      ]),
    ).toBe(true);
  });
});
