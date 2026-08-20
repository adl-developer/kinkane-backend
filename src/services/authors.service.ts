/**
 * Author pages.
 *
 * There is no authors table. An "author" here is a distinct `person_name` on
 * the contributor rows, which has two consequences worth knowing before
 * changing anything:
 *
 *  - **The slug is the identity.** It is derived from the name (see
 *    lib/author-slug), and resolved through an index on the same expression.
 *  - **Two different people who share a name are one author page.** There is no
 *    data here that could tell them apart, and inventing a disambiguation the
 *    catalogue cannot support would be worse than the honest collision.
 *
 * Scoped to role A01 — the primary author — matching authorSuggestions. An
 * illustrator or translator does not get a page from their contribution.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { books, bookContributors } from '../db/schema';
import { booksService, type BookListItem } from './books.service';
import { authorSlug } from '../lib/author-slug';

export interface AuthorDetail {
  slug: string;
  name: string;
  bookCount: number;
}

/**
 * Mirrors `idx_book_contributors_author_slug` exactly. Written as raw SQL
 * rather than composed from helpers so it stays visibly identical to the index
 * definition — the planner only uses the index if the expression matches it
 * character for character.
 */
const slugExpression = sql`btrim(lower(regexp_replace(${bookContributors.personName}, '[^a-zA-Z0-9]+', '-', 'g')), '-')`;

export const authorsService = {
  /**
   * Resolves a slug to an author.
   *
   * Returns the most common spelling of the name when several map to one slug
   * (`N.K. Jemisin` and `N. K. Jemisin` both slug to `n-k-jemisin`), because
   * the page has to display one of them and the prevailing form is the least
   * surprising choice.
   */
  async getBySlug(slug: string): Promise<AuthorDetail | null> {
    const [row] = await db
      .select({
        name: sql<string>`(
          array_agg(${bookContributors.personName} ORDER BY ${bookContributors.personName})
        )[1]`,
        bookCount: sql<number>`COUNT(DISTINCT ${bookContributors.bookId})::int`,
      })
      .from(bookContributors)
      .innerJoin(books, eq(books.id, bookContributors.bookId))
      .where(
        and(
          eq(bookContributors.role, 'A01'),
          eq(books.isRemoved, false),
          sql`${slugExpression} = ${slug}`,
        ),
      )
      .limit(1);

    // An author with no surviving books is not a 404 by accident — every one of
    // their titles was withdrawn, and an empty page would be a dead end.
    if (!row?.name || row.bookCount === 0) return null;

    return { slug, name: row.name, bookCount: row.bookCount };
  },

  /**
   * That author's books, newest first.
   *
   * Delegates to booksService.listByIds so the shape matches every other book
   * list in the API — same contributors, genres, prices and excerpt handling —
   * rather than growing a second, subtly different book serializer.
   */
  async books(
    slug: string,
    options: { limit: number; offset: number },
  ): Promise<{ books: BookListItem[]; total: number; hasMore: boolean }> {
    const [counted] = await db
      .select({ total: sql<number>`COUNT(DISTINCT ${bookContributors.bookId})::int` })
      .from(bookContributors)
      .innerJoin(books, eq(books.id, bookContributors.bookId))
      .where(
        and(
          eq(bookContributors.role, 'A01'),
          eq(books.isRemoved, false),
          sql`${slugExpression} = ${slug}`,
        ),
      );

    const total = counted?.total ?? 0;
    if (total === 0) return { books: [], total: 0, hasMore: false };

    const rows = await db
      .selectDistinct({ bookId: bookContributors.bookId, publicationDate: books.publicationDate })
      .from(bookContributors)
      .innerJoin(books, eq(books.id, bookContributors.bookId))
      .where(
        and(
          eq(bookContributors.role, 'A01'),
          eq(books.isRemoved, false),
          sql`${slugExpression} = ${slug}`,
        ),
      )
      // Undated titles sort last rather than leading the page, which is what
      // NULLS FIRST on a DESC sort would otherwise do.
      .orderBy(sql`${books.publicationDate} DESC NULLS LAST`)
      .limit(options.limit + 1)
      .offset(options.offset);

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;

    const hydrated = await booksService.listByIds(page.map((row) => row.bookId));
    // listByIds does not promise ordering, so re-impose the page's.
    const byId = new Map(hydrated.map((book) => [book.id, book]));

    return {
      books: page.map((row) => byId.get(row.bookId)).filter((book): book is BookListItem => Boolean(book)),
      total,
      hasMore,
    };
  },

  /** The slug the client should link to for a given contributor name. */
  slugFor: authorSlug,
};
