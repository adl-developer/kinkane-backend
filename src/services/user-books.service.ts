import { eq, and, asc, desc, ilike, sql, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  userBooks,
  books,
  users,
  bookContributors,
  bookGenres,
  bookPrices,
  genres,
  type BookContributor,
  type Genre,
  type BookPrice,
} from '../db/schema';
import { redis } from '../lib/redis';

const PUBLIC_NOTES_TTL = 2 * 60; // 2 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserBookItem {
  id: number;
  bookId: number;
  status: string;
  source: string;
  note: string | null;
  noteIsPublic: boolean;
  addedAt: Date;
  isbn13: string | null;
  recordReference: string;
  title: string;
  subtitle: string | null;
  publisherName: string | null;
  imprintName: string | null;
  productForm: string | null;
  publicationDate: string | null;
  publishingStatus: string | null;
  availabilityCode: string | null;
  pageCount: number | null;
  coverUrl: string | null;
  contributors: Pick<BookContributor, 'role' | 'personName' | 'sequenceNumber'>[];
  genres: Pick<Genre, 'name' | 'slug'>[];
  prices: Pick<BookPrice, 'priceType' | 'priceAmount' | 'currencyCode'>[];
}

export interface PublicNote {
  userId: number;
  userName: string;
  userPhotoUrl: string | null;
  note: string;
  status: string;
  addedAt: Date;
}

export interface ListUserBooksOptions {
  userId: number;
  q?: string;
  status?: 'want_to_read' | 'reading' | 'read';
  sort: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface UpsertUserBookFields {
  // C7 fix: use the enum union so internal callers can't pass arbitrary strings
  status?: 'want_to_read' | 'reading' | 'read';
  note?: string | null;
  noteIsPublic?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * C8 fix: escape PostgreSQL LIKE/ILIKE metacharacters in user-supplied strings.
 * Without this, q='_' matches every title and q='%' returns every row.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function attachRelations(bookIds: number[]): Promise<Map<number, {
  contributors: UserBookItem['contributors'];
  genres: UserBookItem['genres'];
  prices: UserBookItem['prices'];
}>> {
  const map = new Map<number, { contributors: UserBookItem['contributors']; genres: UserBookItem['genres']; prices: UserBookItem['prices'] }>();
  bookIds.forEach((id) => map.set(id, { contributors: [], genres: [], prices: [] }));

  if (bookIds.length === 0) return map;

  const [contributors, genreRows, priceRows] = await Promise.all([
    db
      .select({
        bookId: bookContributors.bookId,
        role: bookContributors.role,
        personName: bookContributors.personName,
        sequenceNumber: bookContributors.sequenceNumber,
      })
      .from(bookContributors)
      .where(inArray(bookContributors.bookId, bookIds))
      .orderBy(bookContributors.sequenceNumber),

    db
      .select({ bookId: bookGenres.bookId, name: genres.name, slug: genres.slug })
      .from(bookGenres)
      .innerJoin(genres, eq(genres.id, bookGenres.genreId))
      .where(inArray(bookGenres.bookId, bookIds)),

    db
      .select({
        bookId: bookPrices.bookId,
        priceType: bookPrices.priceType,
        priceAmount: bookPrices.priceAmount,
        currencyCode: bookPrices.currencyCode,
      })
      .from(bookPrices)
      .where(inArray(bookPrices.bookId, bookIds)),
  ]);

  for (const c of contributors) {
    map.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
  }
  for (const g of genreRows) {
    map.get(g.bookId)?.genres.push({ name: g.name, slug: g.slug });
  }
  for (const p of priceRows) {
    map.get(p.bookId)?.prices.push({ priceType: p.priceType, priceAmount: p.priceAmount, currencyCode: p.currencyCode });
  }

  return map;
}

// ── Public service ────────────────────────────────────────────────────────────

export const userBooksService = {
  async list(opts: ListUserBooksOptions): Promise<{ books: UserBookItem[]; total: number }> {
    const conditions: SQL[] = [eq(userBooks.userId, opts.userId)];

    if (opts.status) {
      conditions.push(eq(userBooks.status, opts.status));
    }

    if (opts.q) {
      // C8 fix: escape metacharacters so _ and % in the query are treated as literals
      conditions.push(ilike(books.title, `%${escapeLike(opts.q)}%`));
    }

    const where = and(...conditions);
    const titleOrder = opts.sort === 'desc' ? desc(books.title) : asc(books.title);

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: userBooks.id,
          bookId: userBooks.bookId,
          status: userBooks.status,
          source: userBooks.source,
          note: userBooks.note,
          noteIsPublic: userBooks.noteIsPublic,
          addedAt: userBooks.addedAt,
          isbn13: books.isbn13,
          recordReference: books.recordReference,
          title: books.title,
          subtitle: books.subtitle,
          publisherName: books.publisherName,
          imprintName: books.imprintName,
          productForm: books.productForm,
          publicationDate: books.publicationDate,
          publishingStatus: books.publishingStatus,
          availabilityCode: books.availabilityCode,
          pageCount: books.pageCount,
          coverUrl: books.coverUrl,
        })
        .from(userBooks)
        .innerJoin(books, eq(books.id, userBooks.bookId))
        .where(where)
        .orderBy(titleOrder)
        .limit(opts.limit)
        .offset(opts.offset),

      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userBooks)
        .innerJoin(books, eq(books.id, userBooks.bookId))
        .where(where),
    ]);

    const relations = await attachRelations(rows.map((r) => r.bookId));

    return {
      books: rows.map((r) => ({ ...r, ...relations.get(r.bookId)! })),
      total: countRow?.count ?? 0,
    };
  },

  /**
   * Upserts the user's entry for a book (status, note, visibility).
   * Only the fields present in `fields` are written — omitted fields are left unchanged
   * on update, or set to their column defaults on first insert.
   */
  async upsert(userId: number, bookId: number, fields: UpsertUserBookFields): Promise<void> {
    // Build the update set — only include keys that were explicitly provided
    const updateSet: Record<string, unknown> = {
      // C5 fix: always mark the row as manually managed when the user acts on it
      source: 'manual',
    };
    if (fields.status !== undefined) updateSet.status = fields.status;
    if (fields.note !== undefined) updateSet.note = fields.note;
    if (fields.noteIsPublic !== undefined) updateSet.noteIsPublic = fields.noteIsPublic;

    // C3 fix: Drizzle throws 'No values to set' when the set object is empty.
    // source is always present now so this guard is a safety net for future refactors.
    if (Object.keys(updateSet).length === 0) {
      throw new Error('upsert called with no fields to update');
    }

    // C6 fix: invalidate the cache BEFORE the DB write to close the race window where
    // a concurrent getPublicNotes read could re-populate the cache with pre-write data
    // and then have the del fire too late.
    await redis.del(`book:public-notes:${bookId}`);

    await db
      .insert(userBooks)
      .values({
        userId,
        bookId,
        source: 'manual',
        status: fields.status ?? 'want_to_read',
        note: fields.note ?? null,
        noteIsPublic: fields.noteIsPublic ?? false,
      })
      .onConflictDoUpdate({
        target: [userBooks.userId, userBooks.bookId],
        set: updateSet,
      });
  },

  /**
   * Removes a book from the user's reading list entirely.
   */
  async remove(userId: number, bookId: number): Promise<void> {
    // C6 fix: invalidate cache before the DB write (same reasoning as upsert)
    await redis.del(`book:public-notes:${bookId}`);

    await db
      .delete(userBooks)
      .where(and(eq(userBooks.userId, userId), eq(userBooks.bookId, bookId)));
  },

  /**
   * Returns all public notes for a given book, ordered newest first.
   * Cached for 2 minutes to avoid a DB hit on every book detail view.
   */
  async getPublicNotes(bookId: number): Promise<PublicNote[]> {
    const cacheKey = `book:public-notes:${bookId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const notes = JSON.parse(cached) as PublicNote[];
      return notes.map((n) => ({ ...n, addedAt: new Date(n.addedAt) }));
    }

    const rows = await db
      .select({
        userId: userBooks.userId,
        userName: users.name,
        userPhotoUrl: users.photoUrl,
        note: userBooks.note,
        status: userBooks.status,
        addedAt: userBooks.addedAt,
      })
      .from(userBooks)
      .innerJoin(users, eq(users.id, userBooks.userId))
      .where(
        and(
          eq(userBooks.bookId, bookId),
          eq(userBooks.noteIsPublic, true),
          sql`${userBooks.note} IS NOT NULL`,
        ),
      )
      .orderBy(desc(userBooks.addedAt));

    // note is guaranteed non-null by the WHERE clause above
    const notes: PublicNote[] = rows.map((r) => ({ ...r, note: r.note! }));

    // C4 fix: treat cache-write failure as non-fatal so a Redis blip doesn't
    // turn a successful DB read into a 500 for the caller
    try {
      await redis.set(cacheKey, JSON.stringify(notes), 'EX', PUBLIC_NOTES_TTL);
    } catch {
      // cache miss on the next request is acceptable
    }

    return notes;
  },
};
