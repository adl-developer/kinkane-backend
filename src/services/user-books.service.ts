import bcrypt from 'bcryptjs';
import { eq, and, asc, desc, ilike, sql, inArray, type SQL } from 'drizzle-orm';
import { admin } from '../lib/firebase';
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
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';

const PUBLIC_NOTES_TTL = 2 * 60; // 2 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserBookItem {
  id: number;
  bookId: number;
  status: string | null;
  liked: boolean;
  likedAt: Date | null;
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
  excerpt: BookExcerptInfo | null;
}

export interface UserBookStatus {
  status: string | null;
  liked: boolean;
  note: string | null;
  noteIsPublic: boolean;
}

export interface PublicNote {
  userId: number;
  userName: string;
  userPhotoUrl: string | null;
  note: string;
  status: string | null;
  addedAt: Date;
}

export interface ListUserBooksOptions {
  userId: number;
  q?: string;
  status?: 'want_to_read' | 'reading' | 'read';
  liked?: boolean;
  sort: 'title_asc' | 'title_desc' | 'date_asc' | 'date_desc';
  limit: number;
  offset: number;
}

export interface UpsertUserBookFields {
  status?: 'want_to_read' | 'reading' | 'read';
  note?: string | null;
  noteIsPublic?: boolean;
  liked?: boolean;
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

    if (opts.liked !== undefined) {
      conditions.push(eq(userBooks.liked, opts.liked));
    }

    if (opts.q) {
      // C8 fix: escape metacharacters so _ and % in the query are treated as literals
      conditions.push(ilike(books.title, `%${escapeLike(opts.q)}%`));
    }

    const where = and(...conditions);
    const order =
      opts.sort === 'title_asc' ? asc(books.title)
      : opts.sort === 'title_desc' ? desc(books.title)
      : opts.sort === 'date_asc' ? asc(userBooks.addedAt)
      : desc(userBooks.addedAt); // date_desc

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: userBooks.id,
          bookId: userBooks.bookId,
          status: userBooks.status,
          liked: userBooks.liked,
          likedAt: userBooks.likedAt,
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
        .orderBy(order)
        .limit(opts.limit)
        .offset(opts.offset),

      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userBooks)
        .innerJoin(books, eq(books.id, userBooks.bookId))
        .where(where),
    ]);

    const [relations, excerptMap] = await Promise.all([
      attachRelations(rows.map((r) => r.bookId)),
      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    return {
      books: rows.map((r) => ({
        ...r,
        ...relations.get(r.bookId)!,
        excerpt: pickExcerpt(r.isbn13, excerptMap),
      })),
      total: countRow?.count ?? 0,
    };
  },

  /**
   * Upserts the user's entry for a book (status, note, visibility).
   * Only the fields present in `fields` are written — omitted fields are left unchanged
   * on update, or set to their column defaults on first insert.
   */
  async upsert(userId: number, bookId: number, fields: UpsertUserBookFields): Promise<void> {
    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    if (!book) {
      throw Object.assign(new Error('Book not found'), { statusCode: 404 });
    }

    // Build the update set — only include keys that were explicitly provided
    const updateSet: Record<string, unknown> = {
      source: 'manual',
    };
    if (fields.status !== undefined) updateSet.status = fields.status;
    if (fields.note !== undefined) updateSet.note = fields.note;
    if (fields.noteIsPublic !== undefined) updateSet.noteIsPublic = fields.noteIsPublic;
    if (fields.liked !== undefined) {
      updateSet.liked = fields.liked;
      updateSet.likedAt = fields.liked ? new Date() : null;
    }

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
        status: fields.status ?? null,
        note: fields.note ?? null,
        noteIsPublic: fields.noteIsPublic ?? false,
        liked: fields.liked ?? false,
        likedAt: fields.liked ? new Date() : null,
      })
      .onConflictDoUpdate({
        target: [userBooks.userId, userBooks.bookId],
        set: updateSet,
      });
  },

  /**
   * Likes a book. If the user has no existing entry for it, one is created
   * with no reading status — just the liked flag. Idempotent.
   */
  async like(userId: number, bookId: number): Promise<void> {
    const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, bookId)).limit(1);
    if (!book) {
      throw Object.assign(new Error('Book not found'), { statusCode: 404 });
    }

    await db
      .insert(userBooks)
      .values({
        userId,
        bookId,
        source: 'manual',
        status: null,
        liked: true,
        likedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userBooks.userId, userBooks.bookId],
        set: { liked: true, likedAt: new Date(), source: 'manual' },
      });
  },

  /**
   * Unlikes a book. If the row has no reading status, it is deleted entirely
   * (nothing left to keep it). Otherwise only the liked flag is cleared.
   */
  async unlike(userId: number, bookId: number): Promise<void> {
    const [row] = await db
      .select({ id: userBooks.id, status: userBooks.status })
      .from(userBooks)
      .where(and(eq(userBooks.userId, userId), eq(userBooks.bookId, bookId)))
      .limit(1);

    if (!row) return; // nothing to do

    if (row.status === null) {
      await db.delete(userBooks).where(eq(userBooks.id, row.id));
    } else {
      await db
        .update(userBooks)
        .set({ liked: false, likedAt: null })
        .where(eq(userBooks.id, row.id));
    }
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
   * Deletes every book from the user's reading list and clears any cached
   * public notes for the affected books.
   */
  async resetLibrary(
    userId: number,
    credential: { password: string } | { idToken: string },
  ): Promise<{ deleted: number }> {
    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    if ('idToken' in credential) {
      // Social-login path: verify a fresh Firebase ID token and enforce a
      // 5-minute auth_time window so the user must have just authenticated.
      let decoded: admin.auth.DecodedIdToken;
      try {
        decoded = await admin.auth().verifyIdToken(credential.idToken);
      } catch {
        throw Object.assign(new Error('Invalid Firebase ID token'), { statusCode: 401 });
      }
      const authAge = Math.floor(Date.now() / 1000) - decoded.auth_time;
      if (authAge > 5 * 60) {
        throw Object.assign(
          new Error('Re-authentication required — please sign in again before resetting your library'),
          { statusCode: 401 },
        );
      }
    } else {
      // Password path: standard bcrypt comparison
      if (!user.passwordHash) {
        throw Object.assign(
          new Error('This account uses social login — provide a Firebase ID token instead of a password'),
          { statusCode: 400 },
        );
      }
      const valid = await bcrypt.compare(credential.password, user.passwordHash);
      if (!valid) {
        throw Object.assign(new Error('Incorrect password'), { statusCode: 401 });
      }
    }

    const deleted = await db
      .delete(userBooks)
      .where(eq(userBooks.userId, userId))
      .returning({ bookId: userBooks.bookId });

    if (deleted.length > 0) {
      const pipeline = redis.pipeline();
      for (const { bookId } of deleted) {
        pipeline.del(`book:public-notes:${bookId}`);
      }
      await pipeline.exec();
    }

    return { deleted: deleted.length };
  },

  /**
   * Returns the calling user's shelf entry for a single book (status, liked,
   * note), or null if they've never added it. Powers the "your status on
   * this book" field on the book detail page.
   */
  async getStatus(userId: number, bookId: number): Promise<UserBookStatus | null> {
    const [row] = await db
      .select({
        status: userBooks.status,
        liked: userBooks.liked,
        note: userBooks.note,
        noteIsPublic: userBooks.noteIsPublic,
      })
      .from(userBooks)
      .where(and(eq(userBooks.userId, userId), eq(userBooks.bookId, bookId)))
      .limit(1);

    return row ?? null;
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
