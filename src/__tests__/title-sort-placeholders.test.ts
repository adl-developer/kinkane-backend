import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSortOrderBy, type ListBooksOptions } from '../services/books.service';

/**
 * `GET /books?sortBy=title` used to open on the catalogue's placeholder rows —
 * titles that are punctuation and nothing else (`?`, `.`, `...`), which beat
 * every real book in ASCII order. They now sort last, in both directions.
 *
 * Asserted as SQL rather than executed, for the reason catalogue-filters.test.ts
 * gives: the interesting properties are properties of the query — in particular
 * that the rank does *not* flip with the title, and that its text still matches
 * the index built for it.
 */

const dialect = new PgDialect();
const orderBy = (opts: Partial<ListBooksOptions>) =>
  buildSortOrderBy({ limit: 20, offset: 0, ...opts } as ListBooksOptions)
    // Wrapped because the default branch returns a bare column, not an SQL node.
    .map((clause) => dialect.sqlToQuery(sql`${clause}`).sql)
    .join(', ');

// The one expression both the query and the index are built from. Written out
// here rather than imported so a change to it fails this test loudly instead of
// being followed silently on both sides — the index is only useful while the
// two agree character for character.
const RANK = `case when "books"."title" ~ '[[:alnum:]]' then 0 else 1 end`;

describe('placeholder titles in a title-ordered page', () => {
  it('ranks a title with no letter or digit last, ascending', () => {
    const sql = orderBy({ sortBy: 'title', sort: 'asc' }).toLowerCase();
    expect(sql).toContain(RANK);
    expect(sql.indexOf(RANK)).toBeLessThan(sql.lastIndexOf('"books"."title"'));
    expect(sql).toContain('"books"."title" asc');
  });

  it('keeps them last descending too, instead of floating them to the top', () => {
    // The whole point of the rank being a separate always-ASC key. If it ever
    // reverses with the title, `sort=desc` opens on the placeholders again.
    const sql = orderBy({ sortBy: 'title', sort: 'desc' }).toLowerCase();
    expect(sql).toContain(RANK);
    expect(sql).not.toContain(`${RANK} desc`);
    expect(sql).toContain('"books"."title" desc');
  });

  it('applies to a bare `sort`, which has always meant title', () => {
    // sortBy is optional and `sort=asc` alone still selects the title ordering;
    // the placeholder rank has to reach that path too or the fix misses the
    // callers that predate sortBy existing.
    expect(orderBy({ sort: 'asc' }).toLowerCase()).toContain(RANK);
  });

  it('leaves the default and `newest` orderings untouched', () => {
    expect(orderBy({}).toLowerCase()).not.toContain('case when');
    expect(orderBy({ sortBy: 'newest', sort: 'desc' }).toLowerCase()).not.toContain('case when');
    expect(orderBy({ sortBy: 'newest', sort: 'desc' }).toLowerCase()).toContain('nulls last');
  });

  it('tests for an alphanumeric anywhere, not just at the front', () => {
    // `^[[:alnum:]]` would bury real books: quoted titles ("The Nose") and
    // `#Girlboss`-style titles both start on punctuation.
    expect(RANK).not.toContain('^');
    expect(orderBy({ sortBy: 'title' })).not.toContain('^[[:alnum:]]');
  });

  it('has an index whose leading key is that exact expression, in both directions', () => {
    // Without these the ORDER BY cannot use an index at all, and a browse page
    // sorts the whole filtered catalogue before LIMIT applies.
    const migration = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0056_books_title_sortable_index.sql'),
      'utf8',
    ).toLowerCase();
    expect(migration).toContain(`idx_books_title_sortable`);
    expect(migration).toContain(`idx_books_title_sortable_desc`);
    // The migration names the column unqualified, as CREATE INDEX must.
    const rank = RANK.replace('"books".', '');
    expect(migration).toContain(`(${rank}), "title")`);
    expect(migration).toContain(`(${rank}), "title" desc)`);
  });

  it('pre-builds the same two indexes concurrently, character for character', () => {
    // The deploy builds these ahead of drizzle-kit so the migration's IF NOT
    // EXISTS turns into a no-op and nothing takes a write lock on books. That
    // only works while the pre-build describes the *same* index: a drifted
    // expression builds a second index the planner never matches, and the
    // migration then builds the real one under the lock anyway — the exact
    // stall the script exists to avoid, with no error to show for it.
    const script = readFileSync(
      join(__dirname, '..', 'db', 'build-concurrent-indexes.ts'),
      'utf8',
    ).toLowerCase();
    const rank = RANK.replace('"books".', '');
    expect(script).toContain(rank);
    expect(script).toContain('create index concurrently if not exists "idx_books_title_sortable"');
    expect(script).toContain('create index concurrently if not exists "idx_books_title_sortable_desc"');
    expect(script).toContain('"title" desc)');
  });

  it('drops a half-built index rather than letting it satisfy IF NOT EXISTS', () => {
    // An invalid index is unusable by the planner but still counts as existing,
    // so leaving one behind makes the migration skip the index entirely and the
    // page goes quietly slow. The failure path has to drop it.
    const script = readFileSync(
      join(__dirname, '..', 'db', 'build-concurrent-indexes.ts'),
      'utf8',
    );
    expect(script).toContain('indisvalid');
    expect(script).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
  });

  it('runs before drizzle-kit migrate, not after', () => {
    // After would be pointless: the migration would already have built them
    // under a lock, and the pre-build would find them present and skip.
    const pkg = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const migrateScript = (JSON.parse(pkg) as { scripts: Record<string, string> }).scripts['db:migrate']!;
    expect(migrateScript).toContain('build-concurrent-indexes');
    expect(migrateScript.indexOf('build-concurrent-indexes')).toBeLessThan(
      migrateScript.indexOf('drizzle-kit migrate'),
    );
  });
});
