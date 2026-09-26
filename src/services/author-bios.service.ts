import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { authorBios, type AuthorBio, type AuthorBioConfidence } from '../db/schema';
import { logger } from '../lib/logger';
import { attributableContributor, plainText } from '../lib/author-bio-match';

/**
 * Turning per-book biographies into one biography per author.
 *
 * BDS supply a biography per book and no author identifier, so the only thing
 * to key on is the name — and names collide. "John Smith" the historian and
 * "John Smith" the cookery writer are one row here, and serving either man's
 * biography on the other's page is exactly the failure that ruled out building
 * this from Wikipedia.
 *
 * Two defences:
 *
 *  1. Only biographies that survive lib/author-bio-match are considered at
 *     all — a single author on the book, named in the text, with nobody else
 *     named. The same rule the book page uses, so the two can never disagree.
 *  2. When one name's books produce biographies that are *materially
 *     different*, the row is marked 'ambiguous' and nothing is served for that
 *     author. Book pages are unaffected: their biography came with the book,
 *     so it is right regardless of who else shares the name.
 *
 * The cost of (2) is a missing author biography. The cost of getting it wrong
 * is publishing a stranger's life story under someone's name.
 */

/**
 * How alike two biographies must be to count as the same person's.
 *
 * Jaccard overlap of their significant words, with the shared author name
 * excluded. Measured on real data (2026-09-25), after that exclusion:
 *
 *   - The same person, reworded between editions: 0.138 and 0.269 — the only
 *     two authors in 878 whose books carried different text.
 *   - 500 pairs of biographies by different authors: max 0.125, with 1 pair
 *     at or above 0.12 and 4 at or above 0.10.
 *
 * 0.12 sits in the gap, but the gap is narrow (0.125 vs 0.138) and rests on
 * two same-person samples, because the local data has no genuine name
 * collision in it. **Re-measure once the full catalogue is loaded**, when
 * real collisions will exist across ~300k authors.
 *
 * Erring low is deliberate. Treating one person as two costs an author page
 * its biography; treating two people as one publishes a stranger's life story
 * under someone's name.
 */
const SAME_PERSON_SIMILARITY = 0.12;

/** Words too short or too common to be evidence of anything. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'has', 'have', 'was', 'were', 'his', 'her',
  'their', 'they', 'she', 'him', 'who', 'where', 'when', 'about', 'into', 'been', 'also', 'more',
  'book', 'books', 'author', 'writer', 'lives', 'work', 'works', 'published', 'writes', 'writing',
]);

/**
 * The significant words of a biography, as a set.
 *
 * `ignore` takes the author's own name out. That matters more than it looks:
 * every biography of a person names them, so two *different* people who share
 * a name share those words too — the one case where the comparison has to be
 * sharpest is the one the name inflates. Leaving it in made a marine geologist
 * and a children's author look like the same man.
 */
export function significantWords(bioHtml: string, ignore: Iterable<string> = []): Set<string> {
  const skip = new Set([...ignore].map((w) => w.toLowerCase()));
  return new Set(
    plainText(bioHtml)
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !skip.has(w)),
  );
}

/** The words of a name, as they would appear in a biography. */
function nameWords(displayName: string): string[] {
  return plainText(displayName).split(/[^a-z0-9']+/).filter(Boolean);
}

/**
 * Jaccard overlap of two biographies' significant words, 0 to 1. `sharedName`
 * is the author name both are filed under, and is excluded from both sides.
 */
export function bioSimilarity(a: string, b: string, sharedName = ''): number {
  const ignore = nameWords(sharedName);
  const left = significantWords(a, ignore);
  const right = significantWords(b, ignore);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Whether two biographies are plausibly about the same person. */
export function samePerson(a: string, b: string, sharedName = ''): boolean {
  return bioSimilarity(a, b, sharedName) >= SAME_PERSON_SIMILARITY;
}

/** The normalisation used as the key: whitespace collapsed, trimmed, lowercased. */
export function normaliseAuthorName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface Candidate {
  normalisedName: string;
  displayName: string;
  bioHtml: string;
  isbn13: string | null;
  pubDate: string | null;
  sourceUpdated: string | null;
}

/**
 * Merges the candidates for one author into the row to store.
 *
 * The newest book's biography wins — biographies go stale, and a publisher's
 * latest is usually the fullest. Anything that disagrees with it materially
 * makes the whole name ambiguous.
 */
export function mergeCandidates(candidates: Candidate[]): {
  chosen: Candidate;
  confidence: AuthorBioConfidence;
  booksConsidered: number;
} {
  const sorted = [...candidates].sort((a, b) => (b.pubDate ?? '').localeCompare(a.pubDate ?? ''));
  const chosen = sorted[0];
  const disagrees = sorted.slice(1).some((c) => !samePerson(chosen.bioHtml, c.bioHtml, chosen.displayName));

  return {
    chosen,
    confidence: disagrees ? 'ambiguous' : 'high',
    booksConsidered: candidates.length,
  };
}

/** One page of books that have a biography, with their contributors. */
interface BookRow {
  id: number;
  isbn13: string | null;
  bio_html: string;
  pub_date: string | null;
  source_updated: string | null;
  contributors: { role: string | null; personName: string | null }[];
}

async function fetchPage(afterId: number, limit: number): Promise<BookRow[]> {
  return (await db.execute(sql`
    SELECT b.id, b.isbn13, ab.bio_html, b.publication_date::text AS pub_date,
           ab.source_updated,
           json_agg(json_build_object('role', bc.role, 'personName', bc.person_name)
                    ORDER BY bc.sequence_number) AS contributors
    FROM book_author_bios ab
    JOIN books b ON b.isbn13 = ab.isbn13
    JOIN book_contributors bc ON bc.book_id = b.id
    WHERE ab.bio_html IS NOT NULL
      AND b.id > ${afterId}
    GROUP BY b.id, b.isbn13, ab.bio_html, b.publication_date, ab.source_updated
    ORDER BY b.id
    LIMIT ${limit}
  `)) as unknown as BookRow[];
}

/**
 * Rebuilds author_bios from whatever is in book_author_bios today.
 *
 * Walks books by id — a keyset, not an offset, so it stays flat as the table
 * grows — and merges each page into the store. Because a name's books can
 * appear in different pages, the merge is done against what is already stored:
 * a later page that disagrees with an earlier one marks the name ambiguous,
 * and once ambiguous a name stays ambiguous until the next full rebuild.
 */
export async function rebuildAuthorBios(opts: { pageSize?: number } = {}): Promise<{
  booksScanned: number;
  attributed: number;
  authors: number;
  ambiguous: number;
}> {
  const pageSize = opts.pageSize ?? 2_000;
  const stats = { booksScanned: 0, attributed: 0, authors: 0, ambiguous: 0 };

  let afterId = 0;
  for (;;) {
    const page = await fetchPage(afterId, pageSize);
    if (page.length === 0) break;
    afterId = page[page.length - 1].id;
    stats.booksScanned += page.length;

    // Group this page's attributable biographies by author.
    const byAuthor = new Map<string, Candidate[]>();
    for (const row of page) {
      const match = attributableContributor(row.contributors, row.bio_html);
      if (!match) continue;
      stats.attributed++;

      const displayName = match.contributor.personName!.replace(/\s+/g, ' ').trim();
      const key = normaliseAuthorName(displayName);
      const candidate: Candidate = {
        normalisedName: key,
        displayName,
        bioHtml: row.bio_html,
        isbn13: row.isbn13,
        pubDate: row.pub_date,
        sourceUpdated: row.source_updated,
      };
      byAuthor.set(key, [...(byAuthor.get(key) ?? []), candidate]);
    }
    if (byAuthor.size === 0) continue;

    // What we already hold for these authors, so a name split across pages is
    // still compared as a whole.
    const keys = [...byAuthor.keys()];
    // Drizzle's inArray rather than a hand-written ANY(): postgres.js needs a
    // typed array for ANY, and an untyped one fails at parse time.
    const existingRows = await db
      .select({
        normalisedName: authorBios.normalisedName,
        displayName: authorBios.displayName,
        bioHtml: authorBios.bioHtml,
        sourceIsbn13: authorBios.sourceIsbn13,
        sourcePubDate: authorBios.sourcePubDate,
        sourceUpdated: authorBios.sourceUpdated,
        confidence: authorBios.confidence,
        booksConsidered: authorBios.booksConsidered,
      })
      .from(authorBios)
      .where(inArray(authorBios.normalisedName, keys));
    const existing = new Map(existingRows.map((r) => [r.normalisedName, r]));

    const values: Candidate[] = [];
    const confidences = new Map<string, AuthorBioConfidence>();
    const counts = new Map<string, number>();

    for (const [key, candidates] of byAuthor) {
      const prior = existing.get(key);
      const all = prior
        ? [
            ...candidates,
            {
              normalisedName: key,
              displayName: prior.displayName,
              bioHtml: prior.bioHtml,
              isbn13: prior.sourceIsbn13,
              pubDate: prior.sourcePubDate,
              sourceUpdated: prior.sourceUpdated,
            },
          ]
        : candidates;

      const merged = mergeCandidates(all);
      values.push(merged.chosen);
      // Ambiguity is sticky within a run: a name shown to be shared by two
      // people does not stop being shared because a later page agreed.
      const wasAmbiguous = prior?.confidence === 'ambiguous';
      const confidence = wasAmbiguous || merged.confidence === 'ambiguous' ? 'ambiguous' : 'high';
      confidences.set(key, confidence);
      counts.set(key, (prior?.booksConsidered ?? 0) + candidates.length);
      if (confidence === 'ambiguous') stats.ambiguous++;
    }

    for (const value of values) {
      await db
        .insert(authorBios)
        .values({
          normalisedName: value.normalisedName,
          displayName: value.displayName,
          bioHtml: value.bioHtml,
          sourceIsbn13: value.isbn13,
          sourcePubDate: value.pubDate,
          sourceUpdated: value.sourceUpdated,
          confidence: confidences.get(value.normalisedName) ?? 'high',
          booksConsidered: counts.get(value.normalisedName) ?? 1,
        })
        .onConflictDoUpdate({
          target: authorBios.normalisedName,
          set: {
            displayName: sql`excluded.display_name`,
            bioHtml: sql`excluded.bio_html`,
            sourceIsbn13: sql`excluded.source_isbn13`,
            sourcePubDate: sql`excluded.source_pub_date`,
            sourceUpdated: sql`excluded.source_updated`,
            confidence: sql`excluded.confidence`,
            booksConsidered: sql`excluded.books_considered`,
            updatedAt: sql`now()`,
          },
        });
    }
  }

  const [{ count }] = (await db.execute(
    sql`SELECT count(*)::int AS count FROM author_bios WHERE confidence = 'high'`,
  )) as unknown as { count: number }[];
  stats.authors = count;

  logger.info('Author biographies rebuilt', stats);
  return stats;
}

/** The biography to show for an author, or null when there isn't a safe one. */
export async function getAuthorBio(name: string): Promise<AuthorBio | null> {
  const [row] = await db
    .select()
    .from(authorBios)
    .where(and(eq(authorBios.normalisedName, normaliseAuthorName(name)), eq(authorBios.confidence, 'high')))
    .limit(1);
  return row ?? null;
}

/** Which of these author names have a usable biography. */
export async function authorsWithBios(names: string[]): Promise<Set<string>> {
  const keys = [...new Set(names.map(normaliseAuthorName))];
  if (keys.length === 0) return new Set();

  const rows = await db
    .select({ normalisedName: authorBios.normalisedName })
    .from(authorBios)
    .where(and(inArray(authorBios.normalisedName, keys), eq(authorBios.confidence, 'high')));
  return new Set(rows.map((r) => r.normalisedName));
}

export const authorBiosService = { rebuildAuthorBios, getAuthorBio, authorsWithBios };
