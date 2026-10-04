import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll } from 'vitest';
import type { SQL } from 'drizzle-orm';
import type { ExcludedWork } from '../lib/exclusions';

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
 * WRITES NOTHING. `books` and `book_contributors` are shadowed by CTEs of the
 * same name, so the predicate runs against the fixtures below and no table is
 * touched. It still follows the integration-suite convention — TEST_DATABASE_URL
 * only, skipped when unset — so it never runs against the database in `.env`.
 * No migrations are needed: any Postgres with ICU (every standard build) works.
 *
 *   TEST_DATABASE_URL=postgres://localhost:5432/kinkane_test npm run test:integration
 */

const testUrl = process.env.TEST_DATABASE_URL;

function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  const configured = configuredUrl();
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'Point the integration suite at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

type Lib = typeof import('../lib/exclusions');
let lib: Lib;
let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;

const describeIfDb = testUrl ? describe : describe.skip;

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
];

describeIfDb('work exclusion — SQL agrees with its in-memory twin', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    lib = await import('../lib/exclusions');
  });

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
    return lib.filterExcludedWorks(items, { bookIds: [], works }).map((b) => b.id);
  }

  it.each(EXCLUSION_SETS)('keeps the same books for $name', async ({ works }) => {
    const cond = lib.buildWorkExclusionCondition(works)!;
    expect(await keptBySql(cond)).toEqual(keptInMemory(works));
  });

  it('drops every Patchett edition of Bel Canto and nothing else of hers', async () => {
    const cond = lib.buildWorkExclusionCondition(EXCLUSION_SETS[0].works)!;
    const kept = await keptBySql(cond);
    for (const dropped of [1, 2, 3, 4, 7]) expect(kept).not.toContain(dropped);
    // Toft's same-titled book, her other books, and an edition note that is
    // not a subtitle all stay.
    for (const stays of [5, 6, 19]) expect(kept).toContain(stays);
  });

  it('folds every title the same way in SQL as in TypeScript', async () => {
    const titles = CATALOGUE.map((b) => b.title);
    const keys = lib.titleKeysSql(sql`t.title`);
    const rows = (await db.execute(sql`
      SELECT t.title, ${keys.full} AS full, ${keys.core} AS core
      FROM (VALUES ${sql.join(titles.map((t) => sql`(${t}::text)`), sql`, `)}) AS t(title)
    `)) as unknown as { title: string; full: string; core: string }[];
    for (const row of rows) {
      expect({ title: row.title, ...lib.titleKeysForMatch(row.title) }).toEqual(row);
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
      SELECT n.name, ${lib.authorMatchSql(sql`n.name`)} AS folded
      FROM (VALUES ${sql.join(names.map((n) => sql`(${n}::text)`), sql`, `)}) AS n(name)
    `)) as unknown as { name: string; folded: string }[];
    for (const row of rows) {
      expect(lib.normalizeAuthorForMatch(row.name)).toBe(row.folded);
    }
  });
});
