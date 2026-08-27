import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildHasAuthorCondition,
  buildWorkExclusionCondition,
  filterExcludedWorks,
  normalizeForMatch,
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

describe('buildWorkExclusionCondition', () => {
  it('returns undefined for an empty list so callers can spread it', () => {
    expect(buildWorkExclusionCondition([])).toBeUndefined();
  });

  it('normalizes both title and author into the parameters', () => {
    const { params } = compile(
      buildWorkExclusionCondition([{ title: '  Dune ', author: 'Frank HERBERT' }]),
    );
    expect(params).toContain('dune');
    expect(params).toContain('frank herbert');
  });

  it('passes a null author through rather than dropping the work', () => {
    const { params } = compile(buildWorkExclusionCondition([{ title: 'Dune', author: null }]));
    expect(params).toContain('dune');
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

  it('returns the list untouched when the user has rejected nothing', () => {
    const items = [item(1, 'Dune', ['Frank Herbert'])];
    expect(filterExcludedWorks(items, exclusions({}))).toBe(items);
  });
});
