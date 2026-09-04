import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSortOrderBy, type ListBooksOptions } from '../services/books.service';

/**
 * `GET /books?sortBy=title` used to open on the catalogue's least useful rows:
 * punctuation-only titles (`?`, `.`, `...`) beat everything in ASCII order, and
 * digit- and symbol-led titles (`1984`, `£10 Dinners`) beat every letter. The
 * page now sorts into three bands — letters, then digits and symbols, then the
 * placeholders — and the two sunk bands stay at the bottom in both directions.
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
const STRIPPED = `regexp_replace("books"."title" collate "und-x-icu", '^[[:space:]''"#¡¿“”‘’«»‹›]+', '')`;
const RANK =
  `case when "books"."title" is null or "books"."title" collate "und-x-icu" !~ '[[:alnum:]]' then 2 ` +
  `when ${STRIPPED} ~ '^[[:alpha:]]' then 0 else 1 end`;

/** The index forms: same expressions, column unqualified as CREATE INDEX requires. */
const unqualify = (e: string) => e.split('"books".').join('');
const INDEX_RANK = unqualify(RANK);
const INDEX_STRIPPED = unqualify(STRIPPED);

describe('band ordering in a title-ordered page', () => {
  it('sinks the two junk bands below the titles that start with a letter, ascending', () => {
    const sql = orderBy({ sortBy: 'title', sort: 'asc' }).toLowerCase();
    expect(sql).toContain(RANK);
    expect(sql.indexOf(RANK)).toBeLessThan(sql.lastIndexOf('"books"."title"'));
    expect(sql).toContain(`${STRIPPED} asc`);
    expect(sql).toContain('"books"."title" asc');
  });

  it('keeps them last descending too, instead of floating them to the top', () => {
    // The whole point of the rank being a separate always-ASC key. If it ever
    // reverses with the title, `sort=desc` opens on the sunk bands again.
    const sql = orderBy({ sortBy: 'title', sort: 'desc' }).toLowerCase();
    expect(sql).toContain(RANK);
    expect(sql).not.toContain(`${RANK} desc`);
    expect(sql).toContain(`${STRIPPED} desc`);
    expect(sql).toContain('"books"."title" desc');
  });

  it('applies to a bare `sort`, which has always meant title', () => {
    // sortBy is optional and `sort=asc` alone still selects the title ordering;
    // the band rank has to reach that path too or the fix misses the callers
    // that predate sortBy existing.
    expect(orderBy({ sort: 'asc' }).toLowerCase()).toContain(RANK);
  });

  it('leaves the default and `newest` orderings untouched', () => {
    expect(orderBy({}).toLowerCase()).not.toContain('case when');
    expect(orderBy({ sortBy: 'newest', sort: 'desc' }).toLowerCase()).not.toContain('case when');
    expect(orderBy({ sortBy: 'newest', sort: 'desc' }).toLowerCase()).toContain('nulls last');
  });

  it('separates the three bands rather than collapsing back to two', () => {
    // 2 for the placeholders, 0 for a leading letter, 1 for everything left —
    // which is the digit- and symbol-led titles this ordering exists to sink.
    expect(RANK).toContain('then 2');
    expect(RANK).toContain('then 0');
    expect(RANK).toContain('else 1');
  });

  it('reads the first character past any leading decoration', () => {
    // A bare `^[[:alpha:]]` would bury real books along with the junk: quoted
    // titles ("The Nose"), `'Tis the Season`, `#Girlboss` and `¿Quién?` all
    // open on punctuation and all belong in band 0.
    expect(RANK).toContain('regexp_replace');
    for (const decoration of ['"', "''", '#', '¡¿', '“”', '‘’', '«»']) {
      expect(STRIPPED).toContain(decoration);
    }
  });

  it('orders on the stripped title, not the raw one, so quotes do not lead the page', () => {
    // Ranking a quoted title as a real book but still ordering it on the raw
    // string just moves the problem from the bottom of the page to the top:
    // `"` sorts below every letter, so page one of A–Z becomes all `"…"`
    // titles. The stripped key files them under their first letter instead.
    const sql = orderBy({ sortBy: 'title', sort: 'asc' }).toLowerCase();
    expect(sql.indexOf(STRIPPED + ' asc')).toBeLessThan(sql.indexOf('"books"."title" asc'));
  });

  it('keeps the raw title as a tiebreak, so paging past a decorated pair is stable', () => {
    // Two titles differing only in decoration collate equal on the stripped
    // key; without a deterministic third key their relative order is whatever
    // the plan happens to produce, and a row can repeat or vanish across pages.
    const sql = orderBy({ sortBy: 'title', sort: 'asc' }).toLowerCase();
    expect(sql.endsWith('"books"."title" asc')).toBe(true);
  });

  it('ranks NULL with the placeholders and not above them', () => {
    // `NULL !~ '...'` is NULL, not true, so without the explicit IS NULL arm the
    // CASE falls past both WHENs and a NULL title lands in band 1 — ahead of the
    // punctuation-only rows it belongs with.
    expect(RANK).toContain('"books"."title" is null or');
  });

  it('classifies letters by Unicode, not by the database ctype', () => {
    // Postgres takes a regex character class from the operand's ctype, and this
    // database is ctype C: uncollated, `'É' ~ '[[:alpha:]]'` is false, so every
    // accented-initial title (Élégance, Öl und Wein, Čapek, Москва, 東京) would
    // sink into band 1 with the symbols. The ICU collation also stops the
    // banding differing between environments created with different ctypes.
    const collated = (RANK.match(/collate "und-x-icu"/g) ?? []).length;
    expect(collated).toBe(2);
    expect(orderBy({ sortBy: 'title' })).toContain('COLLATE "und-x-icu"');
  });

  it('has an index whose leading key is that exact expression, in both directions', () => {
    // Without these the ORDER BY cannot use an index at all, and a browse page
    // sorts the whole filtered catalogue before LIMIT applies.
    const migration = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0061_books_title_sortable_rank_v2.sql'),
      'utf8',
    ).toLowerCase();
    expect(migration).toContain(`idx_books_title_band`);
    expect(migration).toContain(`idx_books_title_band_desc`);
    expect(migration).toContain(`(${INDEX_RANK}), (${INDEX_STRIPPED}), "title")`);
    expect(migration).toContain(`(${INDEX_RANK}), (${INDEX_STRIPPED}) desc, "title" desc)`);
  });

  it('drops the two-band indexes it supersedes instead of leaving them to be written', () => {
    // They lead on an expression nothing orders by any more, so they answer no
    // query and still cost every insert and update on a ~2M-row table.
    const migration = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0061_books_title_sortable_rank_v2.sql'),
      'utf8',
    ).toLowerCase();
    expect(migration).toContain('drop index if exists "idx_books_title_sortable"');
    expect(migration).toContain('drop index if exists "idx_books_title_sortable_desc"');
  });

  it('gives the new indexes new names, so a stale one cannot satisfy IF NOT EXISTS', () => {
    // The quiet failure this guards: IF NOT EXISTS matches on name, not
    // definition. Reusing idx_books_title_sortable would find the old two-band
    // index, skip the create, and leave the page ordering on an expression no
    // index satisfies — a full sort of the filtered catalogue, and no error.
    const migration = readFileSync(
      join(__dirname, '..', '..', 'drizzle', '0061_books_title_sortable_rank_v2.sql'),
      'utf8',
    ).toLowerCase();
    expect(migration).not.toContain('create index if not exists "idx_books_title_sortable"');
    expect(migration).not.toContain('create index if not exists "idx_books_title_sortable_desc"');
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
    expect(script).toContain(INDEX_RANK);
    expect(script).toContain(INDEX_STRIPPED);
    expect(script).toContain('create index concurrently if not exists "idx_books_title_band"');
    expect(script).toContain('create index concurrently if not exists "idx_books_title_band_desc"');
    expect(script).toContain('"title" desc)');
  });

  it('drops the superseded indexes concurrently too, ahead of the migration', () => {
    // The migration's plain DROP needs an ACCESS EXCLUSIVE lock on books, and
    // waiting for it queues every writer behind it. Dropping concurrently first
    // leaves the migration's DROP IF EXISTS with nothing to do.
    const script = readFileSync(
      join(__dirname, '..', 'db', 'build-concurrent-indexes.ts'),
      'utf8',
    );
    expect(script).toContain("'idx_books_title_sortable'");
    expect(script).toContain("'idx_books_title_sortable_desc'");
    expect(script).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
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
