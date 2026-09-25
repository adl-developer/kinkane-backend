import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * Building author-level biographies against a real Postgres.
 *
 * The case that matters is the last one: two different people sharing a name.
 * Everything else here exists to prove that case is not reached by accident.
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
    throw new Error(`TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}).`);
  }
  process.env.DATABASE_URL = testUrl;
}

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let svc: typeof import('../services/author-bios.service');

const PREFIX = 'AUTHORBIO-';
const describeIfDb = testUrl ? describe : describe.skip;

/** Two biographies of one person, reworded — real text, scoring 0.30. */
const GREEN_2019 =
  '<p>John Patrick Green lives and works in New York City where he makes books and comics about animals with human jobs, notably the smash-hit graphic novel series InvestiGators.</p>';
const GREEN_2024 =
  '<p>John Patrick Green is a human with the human job of making books about animals with human jobs, notably the smash-hit graphic novel series InvestiGators.</p>';
/** A different person entirely, who happens to share the name. */
const OTHER_GREEN =
  '<p>John Patrick Green is Professor of Marine Geology at Bangor University and has led expeditions to survey the Atlantic seabed.</p>';

describeIfDb('author biographies', () => {
  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    svc = await import('../services/author-bios.service');

    const [present] = (await db.execute(sql`SELECT to_regclass('public.author_bios') AS t`)) as unknown as {
      t: string | null;
    }[];
    if (!present?.t) throw new Error('author_bios missing from TEST_DATABASE_URL. Run `npm run db:migrate` against it.');
  });

  async function clean() {
    await db.execute(sql`TRUNCATE author_bios`);
    await db.execute(sql`TRUNCATE book_author_bios`);
    await db.execute(sql`DELETE FROM books WHERE record_reference LIKE ${PREFIX + '%'}`);
  }

  beforeEach(clean);
  afterAll(async () => {
    if (testUrl) await clean();
  });

  /** A book with one author, a publication date, and a BDS biography. */
  async function addBook(isbn13: string, pubDate: string, authorName: string, bioHtml: string, role = 'A01') {
    const [book] = (await db.execute(sql`
      INSERT INTO books (record_reference, isbn13, title, publishing_status, publication_date)
      VALUES (${PREFIX + isbn13}, ${isbn13}, ${'Book ' + isbn13}, '04', ${pubDate})
      RETURNING id
    `)) as unknown as { id: number }[];
    await db.execute(sql`
      INSERT INTO book_contributors (book_id, sequence_number, role, person_name)
      VALUES (${book.id}, 1, ${role}, ${authorName})
    `);
    await db.execute(sql`
      INSERT INTO book_author_bios (isbn13, bio_html, source_field) VALUES (${isbn13}, ${bioHtml}, 'author_bio')
    `);
    return book.id;
  }

  async function storedBio(name: string) {
    const rows = (await db.execute(sql`
      SELECT display_name, bio_html, confidence, books_considered, source_isbn13
      FROM author_bios WHERE normalised_name = ${svc.normaliseAuthorName(name)}
    `)) as unknown as {
      display_name: string; bio_html: string; confidence: string; books_considered: number; source_isbn13: string;
    }[];
    return rows[0];
  }

  it('stores one biography per author, from their newest book', async () => {
    await addBook('9780000001001', '2019-03-01', 'John Patrick Green', GREEN_2019);
    await addBook('9780000001002', '2024-08-01', 'John Patrick Green', GREEN_2024);

    const stats = await svc.rebuildAuthorBios({ pageSize: 10 });
    expect(stats.attributed).toBe(2);

    const row = await storedBio('John Patrick Green');
    expect(row.bio_html).toBe(GREEN_2024);
    expect(row.source_isbn13).toBe('9780000001002');
    expect(row.confidence).toBe('high');
    expect(row.books_considered).toBe(2);
  });

  it('serves nothing for a name two different people share', async () => {
    await addBook('9780000001003', '2024-01-01', 'John Patrick Green', GREEN_2024);
    await addBook('9780000001004', '2021-01-01', 'John Patrick Green', OTHER_GREEN);

    await svc.rebuildAuthorBios({ pageSize: 10 });

    expect((await storedBio('John Patrick Green')).confidence).toBe('ambiguous');
    // The guard is what the endpoint reads, so nothing is served.
    expect(await svc.getAuthorBio('John Patrick Green')).toBeNull();
    expect(await svc.authorsWithBios(['John Patrick Green'])).toEqual(new Set());
  });

  it('still flags the collision when the two books fall in different pages', async () => {
    // The merge has to compare against what is already stored, not just the
    // page in hand — otherwise paging would hide a collision.
    await addBook('9780000001005', '2024-01-01', 'John Patrick Green', GREEN_2024);
    await addBook('9780000001006', '2021-01-01', 'John Patrick Green', OTHER_GREEN);

    await svc.rebuildAuthorBios({ pageSize: 1 });

    expect((await storedBio('John Patrick Green')).confidence).toBe('ambiguous');
  });

  it('treats doubled internal spaces as the same author', async () => {
    await addBook('9780000001007', '2024-01-01', 'John Patrick  Green', GREEN_2024);
    await svc.rebuildAuthorBios({ pageSize: 10 });

    const bio = await svc.getAuthorBio('John Patrick Green');
    expect(bio?.bioHtml).toBe(GREEN_2024);
    // The display name keeps a single space rather than the feed's doubled one.
    expect(bio?.displayName).toBe('John Patrick Green');
  });

  it('ignores a biography that names nobody in an author role', async () => {
    // An edited collection: the contributor is an editor, so the book-level
    // biography is never promoted to an author page.
    await addBook('9780000001008', '2024-01-01', 'John Patrick Green', GREEN_2024, 'B01');

    const stats = await svc.rebuildAuthorBios({ pageSize: 10 });
    expect(stats.attributed).toBe(0);
    expect(await svc.getAuthorBio('John Patrick Green')).toBeNull();
  });

  it('ignores a biography about somebody other than the book\'s author', async () => {
    await addBook('9780000001009', '2024-01-01', 'Someone Else Entirely', GREEN_2024);

    const stats = await svc.rebuildAuthorBios({ pageSize: 10 });
    expect(stats.attributed).toBe(0);
  });
});
