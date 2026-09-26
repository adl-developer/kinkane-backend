import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { canonical, historyScope } from '../services/preference-history.service';
import { historyQuerySchema } from '../controllers/preference-history.controller';

// `canonical` decides whether a preference save is a real change or a no-op.
// If it's too strict the history fills with duplicate rows; if it's too loose
// real changes go unrecorded.
describe('canonical (preference change detection)', () => {
  it('treats reordered arrays as unchanged', () => {
    expect(canonical(['fantasy', 'crime'])).toBe(canonical(['crime', 'fantasy']));
  });

  it('treats reordered object keys as unchanged', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }));
  });

  it('detects an added array element', () => {
    expect(canonical(['crime'])).not.toBe(canonical(['crime', 'fantasy']));
  });

  it('detects a removed array element', () => {
    expect(canonical(['crime', 'fantasy'])).not.toBe(canonical(['crime']));
  });

  it('normalizes nested dislikes objects regardless of ordering', () => {
    const a = { emotionalTone: ['bleak', 'sad'], genreFocus: ['horror'] };
    const b = { genreFocus: ['horror'], emotionalTone: ['sad', 'bleak'] };
    expect(canonical(a)).toBe(canonical(b));
  });

  it('detects a change nested inside dislikes', () => {
    const a = { emotionalTone: ['bleak'] };
    const b = { emotionalTone: ['bleak', 'sad'] };
    expect(canonical(a)).not.toBe(canonical(b));
  });

  it('treats an absent key and an undefined value as the same', () => {
    expect(canonical({ emotionalTone: ['sad'], genreFocus: undefined })).toBe(
      canonical({ emotionalTone: ['sad'] }),
    );
  });

  it('distinguishes null from an empty array', () => {
    expect(canonical(null)).not.toBe(canonical([]));
  });

  it('does not confuse a number with its string form', () => {
    expect(canonical([1, 2])).not.toBe(canonical(['1', '2']));
  });

  it('treats reader type changes as changes', () => {
    expect(canonical('The Seeker')).not.toBe(canonical('The Book-ist'));
    expect(canonical(null)).not.toBe(canonical('The Seeker'));
  });
});

// `historyScope` drives the per-section history screens (mood, genre, what to
// avoid). Rendered through the real Postgres dialect so these assert the SQL
// that runs, not the builder's internals.
describe('historyScope (per-section history filter)', () => {
  const dialect = new PgDialect();
  const render = (field?: Parameters<typeof historyScope>[1]) =>
    dialect.sqlToQuery(historyScope(42, field));

  it('without a field, returns only the caller’s rows', () => {
    const q = render();
    expect(q.sql).toContain('"user_id" = $1');
    expect(q.sql).not.toContain('changed_fields');
    expect(q.params).toEqual([42]);
  });

  it('with a field, matches rows where that field changed', () => {
    const q = render('genres');
    expect(q.sql).toMatch(/"changed_fields" @> \$2::jsonb/);
    expect(q.params).toEqual([42, '["genres"]']);
  });

  it('with a field, keeps the baseline row so a never-edited section is not empty', () => {
    expect(render('dislikes').sql).toContain(`"changed_fields" = '[]'::jsonb`);
  });

  it('keeps the user scope ANDed outside the OR', () => {
    // An OR that escaped its parentheses would return every user's baseline row.
    const { sql } = render('feelings');
    expect(sql).toMatch(/"user_id" = \$1 and \(.*@>.*OR.*= '\[\]'::jsonb\)\)$/s);
  });
});

describe('historyQuerySchema', () => {
  it('accepts the three section fields', () => {
    for (const field of ['feelings', 'genres', 'dislikes']) {
      expect(historyQuerySchema.safeParse({ field }).success).toBe(true);
    }
  });

  it('rejects a field the history does not track', () => {
    expect(historyQuerySchema.safeParse({ field: 'mood' }).success).toBe(false);
  });

  it('leaves field unset by default', () => {
    expect(historyQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });
});
