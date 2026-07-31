import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
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
    const { sql } = compile(
      buildWorkExclusionCondition([
        { title: 'a', author: 'x' },
        { title: 'b', author: 'y' },
        { title: 'c', author: 'z' },
      ]),
    );
    expect(sql.match(/NOT EXISTS/g)).toHaveLength(1);
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
    const kept = filterExcludedWorks(
      [item(99, 'Dune', ['Frank Herbert'], 'B06')],
      exclusions({ works: [{ title: 'dune', author: 'frank herbert' }] }),
    );
    expect(kept.map((b) => b.id)).toEqual([99]);
  });

  it('returns the list untouched when the user has rejected nothing', () => {
    const items = [item(1, 'Dune', ['Frank Herbert'])];
    expect(filterExcludedWorks(items, exclusions({}))).toBe(items);
  });
});
