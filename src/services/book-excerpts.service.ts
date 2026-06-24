import { inArray } from 'drizzle-orm';
import { db } from '../db';
import { bookExcerpts } from '../db/schema';

export interface BookExcerptInfo {
  title: string | null;
  url: string | null;
  available: boolean;
}

/**
 * Batch-looks-up excerpts for a set of ISBNs. Filters out nulls before
 * querying so callers can pass `isbn13` columns directly without checking.
 */
export async function getExcerptsByIsbns(
  isbns: (string | null)[],
): Promise<Map<string, BookExcerptInfo>> {
  const map = new Map<string, BookExcerptInfo>();

  const uniqueIsbns = [...new Set(isbns.filter((isbn): isbn is string => isbn !== null))];
  if (uniqueIsbns.length === 0) return map;

  const rows = await db
    .select({
      isbn13: bookExcerpts.isbn13,
      title: bookExcerpts.title,
      url: bookExcerpts.url,
      available: bookExcerpts.available,
    })
    .from(bookExcerpts)
    .where(inArray(bookExcerpts.isbn13, uniqueIsbns));

  for (const row of rows) {
    map.set(row.isbn13, { title: row.title, url: row.url, available: row.available });
  }

  return map;
}

/** Looks up the excerpt for a single ISBN, or null if there isn't one or none was provided. */
export function pickExcerpt(
  isbn13: string | null,
  excerptMap: Map<string, BookExcerptInfo>,
): BookExcerptInfo | null {
  if (!isbn13) return null;
  return excerptMap.get(isbn13) ?? null;
}
