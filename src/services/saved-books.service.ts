/**
 * Saved Books — the shop's purchase wishlist.
 *
 * Reads are priced through `availabilityService`, the same gate that prices the
 * basket and charges at checkout, so a saved book shows the price it will
 * actually cost. A wishlist quoting a stale price is worse than one quoting
 * none: the customer comes back weeks later specifically to buy at the number
 * they remember.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { savedBooks, books, bookContributors } from '../db/schema';
import { availabilityService } from './commerce/availability.service';
import { resolveCurrency, toPresentment } from './commerce/pricing';

export interface SavedBookView {
  bookId: number;
  isbn13: string | null;
  title: string;
  contributor: string | null;
  coverUrl: string | null;
  savedAt: Date;
  /** Null when the book can no longer be bought — see `unavailableReason`. */
  unitPriceMinor: number | null;
  compareAtMinor: number | null;
  inStock: boolean;
  unavailable: boolean;
  unavailableReason: string | null;
}

export const savedBooksService = {
  /**
   * The user's wishlist, newest first, priced live.
   *
   * Books that have since become unbuyable are **kept and flagged**, not
   * dropped. Someone who saved a title deserves to be told it is no longer
   * available rather than watching it silently disappear and wondering whether
   * they imagined saving it.
   */
  async list(
    userId: number,
    options: { limit: number; offset: number; currency?: string | null; countryCode?: string | null },
  ): Promise<{ books: SavedBookView[]; total: number; hasMore: boolean }> {
    const currency = resolveCurrency({
      requested: options.currency,
      countryCode: options.countryCode,
    });

    const rows = await db
      .select({
        bookId: savedBooks.bookId,
        savedAt: savedBooks.createdAt,
        isbn13: books.isbn13,
        title: books.title,
        coverUrl: books.coverUrl,
      })
      .from(savedBooks)
      .innerJoin(books, eq(books.id, savedBooks.bookId))
      // A withdrawn title is not shown, matching every other catalogue surface.
      .where(and(eq(savedBooks.userId, userId), eq(books.isRemoved, false)))
      .orderBy(desc(savedBooks.createdAt))
      .limit(options.limit + 1)
      .offset(options.offset);

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;

    // A wishlist is small by nature — bounded by how many books one person
    // bothers to save — so an exact count is cheap here, unlike on the
    // catalogue where it has to be capped.
    const [counted] = await db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(savedBooks)
      .innerJoin(books, eq(books.id, savedBooks.bookId))
      .where(and(eq(savedBooks.userId, userId), eq(books.isRemoved, false)));
    const total = counted?.total ?? 0;

    if (page.length === 0) return { books: [], total, hasMore: false };

    const { buyable, rejected } = await availabilityService.check(
      page.map((row) => row.bookId),
      options.countryCode ?? '',
    );

    const contributors = await db
      .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
      .from(bookContributors)
      .where(inArray(bookContributors.bookId, page.map((row) => row.bookId)))
      .orderBy(bookContributors.sequenceNumber);

    const contributorByBook = new Map<number, string>();
    for (const row of contributors) {
      if (row.personName && !contributorByBook.has(row.bookId)) {
        contributorByBook.set(row.bookId, row.personName);
      }
    }

    return {
      total,
      hasMore,
      books: page.map((row) => {
        const live = buyable.get(row.bookId);
        const reason = live ? null : (rejected.get(row.bookId) ?? 'not_found');
        return {
          bookId: row.bookId,
          isbn13: row.isbn13,
          title: row.title,
          contributor: live?.contributor ?? contributorByBook.get(row.bookId) ?? null,
          coverUrl: row.coverUrl,
          savedAt: row.savedAt,
          unitPriceMinor: live ? toPresentment(live.unitPriceGbpPence, currency) : null,
          compareAtMinor:
            live?.compareAtGbpPence != null
              ? toPresentment(live.compareAtGbpPence, currency)
              : null,
          inStock: (live?.stockQty ?? 0) > 0,
          unavailable: !live,
          unavailableReason: reason,
        };
      }),
    };
  },

  /**
   * Saves a book. Idempotent — saving twice is the same as saving once, which
   * is what the unique index on (user_id, book_id) turns into a no-op rather
   * than a duplicate row or an error the client has to interpret.
   */
  async add(userId: number, bookId: number): Promise<{ saved: boolean }> {
    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, bookId), eq(books.isRemoved, false)))
      .limit(1);

    if (!book) {
      throw Object.assign(new Error('Book not found'), { statusCode: 404, code: 'BOOK_NOT_FOUND' });
    }

    await db.insert(savedBooks).values({ userId, bookId }).onConflictDoNothing();
    return { saved: true };
  },

  /** Removes a book. Also idempotent: removing something absent is success. */
  async remove(userId: number, bookId: number): Promise<{ removed: boolean }> {
    const deleted = await db
      .delete(savedBooks)
      .where(and(eq(savedBooks.userId, userId), eq(savedBooks.bookId, bookId)))
      .returning({ id: savedBooks.id });

    return { removed: deleted.length > 0 };
  },

  /**
   * Which of these books the user has saved.
   *
   * Batched so a grid of twenty cards can render its heart icons in one query
   * rather than twenty.
   */
  async savedIds(userId: number, bookIds: number[]): Promise<number[]> {
    if (bookIds.length === 0) return [];
    const rows = await db
      .select({ bookId: savedBooks.bookId })
      .from(savedBooks)
      .where(and(eq(savedBooks.userId, userId), inArray(savedBooks.bookId, bookIds)));
    return rows.map((row) => row.bookId);
  },
};
