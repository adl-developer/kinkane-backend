import { describe, it, expect } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  authorMatchSql,
  buildWorkExclusionCondition,
  filterExcludedWorks,
  normalizeAuthorForMatch,
  titleKeysForMatch,
  titleKeysSql,
  type ExcludedWork,
} from '../lib/exclusions';

/**
 * The work-exclusion rule, run by a real Postgres and checked against its
 * in-memory twin.
 *
 * WHY THIS EXISTS. "Don't show this user a book they already told us about" is
 * written twice: once in SQL (quiz results, the home feed, emails) and once in
 * TypeScript (the shared "you may also like" cache). The SQL leans on Postgres
 * regex behaviour — lookbehind, ICU character classes, a 1-based array from
 * regexp_matches — that a unit test with a mocked database cannot see. If the
 * two drift, the same book is hidden on one screen and shown on the next, and
 * nothing fails.
 *
 * WHERE IT RUNS. Part of the endpoint contract suite (vitest.endpoints.config.ts),
 * so the pre-commit hook runs it against the `.env` database on every commit.
 * That is safe because it READS NOTHING AND WRITES NOTHING: `books` and
 * `book_contributors` are shadowed by CTEs of the same name, so the predicate
 * runs against the fixtures below and only needs a Postgres with ICU (every
 * standard build).
 */

interface Fixture {
  id: number;
  title: string;
  authors: string[];
}

// Every case the rule distinguishes, plus spellings chosen to stress the SQL
// twin: non-breaking spaces, accents, a separator inside a bracket, a bracket
// that opens the title, Roman numerals in and out of brackets.
const CATALOGUE: Fixture[] = [
  { id: 1, title: 'Bel Canto', authors: ['Ann Patchett'] },
  { id: 2, title: 'Bel Canto: A Novel', authors: ['Patchett, Ann'] },
  { id: 3, title: 'Bel Canto (Harper Perennial Modern Classics)', authors: ['Ann  Patchett'] },
  { id: 4, title: 'Bel Canto: A Novel', authors: ['ANN PATCHETT'] },
  { id: 5, title: 'Bel Canto', authors: ['Robert  Toft'] },
  { id: 6, title: 'Whistler', authors: ['Ann Patchett'] },
  { id: 7, title: 'Bel Canto', authors: [] },
  { id: 8, title: 'Warriors: Fading Echoes', authors: ['Erin Hunter'] },
  { id: 9, title: "Warriors: A Warrior's Choice", authors: ['Erin Hunter'] },
  { id: 10, title: 'Tokyo Ghoul (Vol. 3)', authors: ['Sui Ishida'] },
  { id: 11, title: 'Tokyo Ghoul (Vol. 9)', authors: ['Sui Ishida'] },
  { id: 12, title: 'Moby Dick (Penguin Classics 100)', authors: ['Herman Melville'] },
  { id: 13, title: 'Moby Dick (Vol 1 of 2)', authors: ['Herman Melville'] },
  { id: 14, title: 'Good Omens', authors: ['Neil Gaiman'] },
  { id: 15, title: 'Les Misérables: Tome II', authors: ['Victor Hugo'] },
  { id: 16, title: 'Les Misérables', authors: ['Victor Hugo'] },
  { id: 17, title: '(Un)Natural', authors: ['A. N. Author'] },
  { id: 18, title: 'Lord of the Rings (Book I)', authors: ['J. R. R. Tolkien'] },
  { id: 19, title: 'Bel Canto (Penguin: Modern Classics) Edition', authors: ['Ann Patchett'] },
  { id: 20, title: "Dracula's Guest", authors: ['Bram Stoker'] },
  { id: 21, title: 'Dune', authors: ['.'] },
  { id: 22, title: 'Dune', authors: ['Frank Herbert'] },
  { id: 23, title: 'A Game of Thrones', authors: ['George R. R. Martin'] },
  { id: 24, title: 'A Game of Thrones: Book 1 of A Song of Ice and Fire', authors: ['George R.R. Martin'] },
  { id: 25, title: 'A Clash of Kings: Book 2 of A Song of Ice and Fire', authors: ['George R. R. Martin'] },
  { id: 26, title: 'Hedgewitch: Stonewitch', authors: ['Skye McKenna'] },
  { id: 27, title: 'Bel Canto(Large Print)', authors: ['Ann Patchett'] },
  { id: 28, title: 'Bel Canto—A Novel', authors: ['Ann Patchett'] },
  { id: 29, title: 'Catch-22: 50th Anniversary Edition', authors: ['Joseph Heller'] },
  { id: 30, title: 'The War 1914–1918', authors: ['A. Historian'] },
  { id: 31, title: 'Friend(s) Forever', authors: ['A. N. Author'] },
  { id: 32, title: 'Tokyo Ghoul (Vol. 2) (Collector\'s Edition)', authors: ['Sui Ishida'] },
  { id: 33, title: 'AMERICANAH PB', authors: ['Chimamanda Ngozi Adichie'] },
  { id: 34, title: 'Americanah', authors: ['Ngozi Adichie, Chimamanda'] },
  { id: 35, title: 'Dune Messiah', authors: ['Frank Herbert'] },
  { id: 36, title: 'Bel Cantos', authors: ['Ann Patchett'] },
  { id: 37, title: 'Bel Canto Arias for Soprano', authors: ['Robert Toft'] },
  { id: 38, title: 'It Ends Here', authors: ['A. N. Author'] },
  { id: 39, title: 'Bel Canto (Large Print) PBK', authors: ['Ann Patchett'] },
];

const EXCLUSION_SETS: { name: string; works: ExcludedWork[] }[] = [
  { name: 'Bel Canto by Ann Patchett', works: [{ title: 'bel canto', author: 'ann patchett' }] },
  { name: 'Bel Canto, author unknown', works: [{ title: 'bel canto', author: null }] },
  { name: "a Warriors title", works: [{ title: "warriors: a warrior's choice", author: 'erin hunter' }] },
  { name: 'one Tokyo Ghoul volume', works: [{ title: 'tokyo ghoul (vol. 3)', author: 'sui ishida' }] },
  { name: 'Moby Dick', works: [{ title: 'moby dick', author: 'herman melville' }] },
  {
    name: 'a co-written book',
    works: [
      { title: 'good omens', author: 'terry pratchett' },
      { title: 'good omens', author: 'neil gaiman' },
    ],
  },
  { name: 'Les Misérables', works: [{ title: 'les misérables', author: 'victor hugo' }] },
  { name: 'Lord of the Rings', works: [{ title: 'lord of the rings', author: 'tolkien, j. r. r.' }] },
  { name: "Dracula", works: [{ title: 'dracula', author: 'bram stoker' }] },
  { name: 'Dune with a blank-folding author', works: [{ title: 'dune', author: '.' }] },
  { name: 'A Game of Thrones', works: [{ title: 'a game of thrones', author: 'george r. r. martin' }] },
  {
    name: 'the "Book 1 of" edition',
    works: [{ title: 'a game of thrones: book 1 of a song of ice and fire', author: 'martin, george r. r.' }],
  },
  { name: 'Hedgewitch', works: [{ title: 'hedgewitch', author: 'skye mckenna' }] },
  { name: 'Catch-22', works: [{ title: 'catch-22', author: 'joseph heller' }] },
  { name: 'Americanah', works: [{ title: 'americanah', author: 'chimamanda ngozi adichie' }] },
  { name: 'Americanah PB', works: [{ title: 'americanah pb', author: 'ngozi adichie, chimamanda' }] },
  { name: 'Dune by Frank Herbert', works: [{ title: 'dune', author: 'frank herbert' }] },
  { name: 'a very short title', works: [{ title: 'it', author: 'a. n. author' }] },
  {
    name: 'two works that fold alike',
    works: [
      { title: 'tokyo ghoul vol 2', author: 'sui ishida' },
      { title: 'tokyo ghoul (vol. 2)', author: 'sui ishida' },
    ],
  },
];

describe('work exclusion — SQL agrees with its in-memory twin', () => {
  /** Runs `cond` against the fixture catalogue and returns the ids it keeps. */
  async function keptBySql(cond: SQL): Promise<number[]> {
    const bookRows = CATALOGUE.map((b) => sql`(${b.id}::int, ${b.title}::text)`);
    const contributorRows = CATALOGUE.flatMap((b) =>
      b.authors.map((a) => sql`(${b.id}::int, 'A01'::text, ${a}::text)`),
    );
    // A dummy row keeps the VALUES list non-empty; book 0 does not exist.
    contributorRows.push(sql`(0::int, 'A01'::text, ''::text)`);
    const rows = (await db.execute(sql`
      WITH books(id, title) AS (VALUES ${sql.join(bookRows, sql`, `)}),
           book_contributors(book_id, role, person_name) AS (VALUES ${sql.join(contributorRows, sql`, `)})
      SELECT id FROM books WHERE ${cond} ORDER BY id
    `)) as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  function keptInMemory(works: ExcludedWork[]): number[] {
    const items = CATALOGUE.map((b) => ({
      id: b.id,
      title: b.title,
      contributors: b.authors.map((personName) => ({ role: 'A01', personName })),
    }));
    return filterExcludedWorks(items, { bookIds: [], works }).map((b) => b.id);
  }

  it.each(EXCLUSION_SETS)('keeps the same books for $name', async ({ works }) => {
    const cond = buildWorkExclusionCondition(works)!;
    expect(await keptBySql(cond)).toEqual(keptInMemory(works));
  });

  it('drops every Patchett edition of Bel Canto and nothing else of hers', async () => {
    const cond = buildWorkExclusionCondition(EXCLUSION_SETS[0].works)!;
    const kept = await keptBySql(cond);
    for (const dropped of [1, 2, 3, 4, 7]) expect(kept).not.toContain(dropped);
    // Glued-on edition notes go too, and so does a title of hers that
    // contains "Bel Canto" word for word.
    for (const dropped of [19, 27, 28]) expect(kept).not.toContain(dropped);
    // Toft's same-titled book and her other books stay.
    for (const stays of [5, 6]) expect(kept).toContain(stays);
  });

  it('matches "Book 1 of" with the plain title but keeps the next book', async () => {
    const kept = await keptBySql(buildWorkExclusionCondition(
      [{ title: 'a game of thrones', author: 'george r. r. martin' }],
    )!);
    expect(kept).not.toContain(24);
    expect(kept).toContain(25);
  });

  it('drops a same-author title that contains the one that was read', async () => {
    const kept = await keptBySql(buildWorkExclusionCondition([{ title: 'hedgewitch', author: 'skye mckenna' }])!);
    expect(kept).not.toContain(26);
  });

  it('drops the PB edition of Americanah and keeps Bel Cantos', async () => {
    const americanah = await keptBySql(buildWorkExclusionCondition(EXCLUSION_SETS.find((e) => e.name === 'Americanah')!.works)!);
    for (const dropped of [33, 34]) expect(americanah).not.toContain(dropped);
    const belCanto = await keptBySql(buildWorkExclusionCondition(EXCLUSION_SETS[0].works)!);
    expect(belCanto).not.toContain(39);
    for (const stays of [36, 37]) expect(belCanto).toContain(stays);
  });

  it('folds every title the same way in SQL as in TypeScript', async () => {
    const titles = CATALOGUE.map((b) => b.title);
    const keys = titleKeysSql(sql`t.title`);
    const rows = (await db.execute(sql`
      SELECT t.title, ${keys.full} AS full, ${keys.core} AS core
      FROM (VALUES ${sql.join(titles.map((t) => sql`(${t}::text)`), sql`, `)}) AS t(title)
    `)) as unknown as { title: string; full: string; core: string }[];
    for (const row of rows) {
      expect({ title: row.title, ...titleKeysForMatch(row.title) }).toEqual(row);
    }
  });

  it('folds every author the same way in SQL as in TypeScript', async () => {
    const names = [
      ...new Set(CATALOGUE.flatMap((b) => b.authors)),
      'Martin Luther King, Jr.',
      'Smith, III',
      'X, Y, Z',
      'Durand,\tÉlodie',
      'Élodie Durand',
    ];
    const rows = (await db.execute(sql`
      SELECT n.name, ${authorMatchSql(sql`n.name`)} AS folded
      FROM (VALUES ${sql.join(names.map((n) => sql`(${n}::text)`), sql`, `)}) AS n(name)
    `)) as unknown as { name: string; folded: string }[];
    for (const row of rows) {
      expect(normalizeAuthorForMatch(row.name)).toBe(row.folded);
    }
  });
});
