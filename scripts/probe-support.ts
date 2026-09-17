/**
 * Shared book lookup for the reco-*-probe scripts.
 *
 * Book ids are assigned at ingest, so they differ between databases. A probe
 * that named its books by id would measure whatever books carry those numbers
 * on another database, or fail outright. Everything here picks books at runtime
 * instead, by title and author.
 *
 * Any probe also accepts an explicit id list through an environment variable,
 * for measuring a specific reader on a specific database.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/db';

export interface BookRef {
  title: string;
  /** Primary author as ingested. Disambiguates titles shared by several books. */
  author: string;
}

/**
 * Reads a comma-separated id list from an environment variable, or null when it
 * is unset. A malformed value throws rather than being half-used — a probe that
 * silently drops an id measures a different reader from the one asked for.
 */
export function parseIdOverride(name: string): number[] | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;

  const parts = raw.split(',').map((p) => p.trim());
  const ids = parts.map(Number);
  const bad = parts.filter((_, i) => !Number.isInteger(ids[i]) || ids[i] <= 0);
  if (bad.length > 0) {
    throw new Error(`${name} must be a comma-separated list of book ids; could not read: ${bad.join(', ')}`);
  }
  return ids;
}

/**
 * Finds each book by title and primary author, returning ids in the order
 * given. Only embedded, live rows count, since a probe can do nothing with a
 * book the search cannot see.
 *
 * Throws naming every book it could not find, rather than carrying on with a
 * smaller reader: five liked books and four liked books are different tastes.
 */
export async function resolveBooks(refs: BookRef[]): Promise<number[]> {
  const ids: number[] = [];
  const missing: string[] = [];

  for (const ref of refs) {
    const rows = (await db.execute(sql`
      select b.id
      from books b
      where lower(b.title) = lower(${ref.title})
        and b.embedding is not null
        and b.is_removed = false
        and exists (
          select 1 from book_contributors c
          where c.book_id = b.id and c.role = 'A01'
            and lower(c.person_name) = lower(${ref.author}))
      order by b.id
      limit 1`)) as unknown as { id: number }[];

    if (rows.length === 0) missing.push(`"${ref.title}" by ${ref.author}`);
    else ids.push(rows[0].id);
  }

  if (missing.length > 0) {
    throw new Error(
      `Not found in this catalogue (embedded and live): ${missing.join('; ')}. ` +
        `Pick books this database has, or pass ids explicitly.`,
    );
  }
  return ids;
}

/**
 * The literary reader most of the probes measure: five novels about family,
 * grief and inheritance. Kept as titles and authors so it means the same books
 * on any catalogue that carries them.
 */
export const LITERARY_READER: BookRef[] = [
  { title: 'I Want to Talk to You', author: 'Diana Evans' },
  { title: 'Albion', author: 'Anna Hope' },
  { title: "Talking to My Father's Ghost", author: 'Alex Krokus' },
  { title: 'Where the Jasmine Blooms', author: 'Zeina Sleiman' },
  { title: 'Bad Cree', author: 'Jessica Johns' },
];

/** The liked books for a probe: an explicit override if given, else the literary reader. */
export async function likedBooksForProbe(): Promise<number[]> {
  return parseIdOverride('PROBE_LIKED_IDS') ?? resolveBooks(LITERARY_READER);
}
