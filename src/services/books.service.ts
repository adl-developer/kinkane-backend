import { eq, sql, and, ilike, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  books,
  bookContributors,
  bookGenres,
  bookPrices,
  bookSubjects,
  genres,
  type Book,
  type BookContributor,
  type Genre,
  type BookSubject,
  type BookPrice,
} from '../db/schema';

export interface ListBooksOptions {
  q?: string;
  genre?: string;
  availability?: string;
  productForm?: string;
  publishingStatus?: string;
  publisher?: string;
  limit: number;
  offset: number;
}

// Columns returned in the list view (no descriptions — keep payloads small)
const LIST_COLUMNS = {
  id: books.id,
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
  createdAt: books.createdAt,
  updatedAt: books.updatedAt,
};

type ListBook = typeof LIST_COLUMNS extends Record<string, { _: { data: infer T } }> ? T : Record<string, unknown>;

export interface BookListItem {
  id: number;
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
  createdAt: Date;
  updatedAt: Date;
  contributors: Pick<BookContributor, 'role' | 'personName' | 'sequenceNumber'>[];
  genres: Pick<Genre, 'name' | 'slug'>[];
  prices: Pick<BookPrice, 'priceType' | 'priceAmount' | 'currencyCode'>[];
}

export interface SuggestionItem {
  id: number;
  title: string;
  subtitle: string | null;
  isbn13: string | null;
  productForm: string | null;
  coverUrl: string | null;
  authors: string[];
}

export interface BookDetail extends BookListItem {
  shortDescription: string | null;
  longDescription: string | null;
  editionNumber: number | null;
  pageCount: number | null;
  heightMm: string | null;
  widthMm: string | null;
  thicknessMm: string | null;
  weightGr: string | null;
  countryOfManufacture: string | null;
  countryOfPublication: string | null;
  returnsCode: string | null;
  orderTime: number | null;
  subjects: Pick<BookSubject, 'schemeIdentifier' | 'subjectCode' | 'subjectHeadingText' | 'isMainSubject'>[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWhereClause(opts: ListBooksOptions, useFts: boolean): SQL | undefined {
  const conditions: SQL[] = [];

  if (opts.q && useFts) {
    conditions.push(
      sql`${books.searchVector} @@ plainto_tsquery('english', ${opts.q})`,
    );
  }

  if (opts.genre) {
    // Subquery: book must appear in book_genres for this genre slug
    conditions.push(
      sql`${books.id} IN (
        SELECT bg.book_id FROM book_genres bg
        JOIN genres g ON g.id = bg.genre_id
        WHERE g.slug = ${opts.genre}
      )`,
    );
  }

  if (opts.availability) {
    conditions.push(eq(books.availabilityCode, opts.availability));
  }

  if (opts.productForm) {
    conditions.push(eq(books.productForm, opts.productForm));
  }

  if (opts.publishingStatus) {
    conditions.push(eq(books.publishingStatus, opts.publishingStatus));
  }

  if (opts.publisher) {
    conditions.push(ilike(books.publisherName, `%${opts.publisher}%`));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

async function attachRelationsToList(
  rows: { id: number }[],
): Promise<Map<number, { contributors: BookListItem['contributors']; genres: BookListItem['genres']; prices: BookListItem['prices'] }>> {
  const ids = rows.map((r) => r.id);
  const map = new Map<number, { contributors: BookListItem['contributors']; genres: BookListItem['genres']; prices: BookListItem['prices'] }>();
  ids.forEach((id) => map.set(id, { contributors: [], genres: [], prices: [] }));

  if (ids.length === 0) return map;

  const [contributors, genreRows, priceRows] = await Promise.all([
    db
      .select({
        bookId: bookContributors.bookId,
        role: bookContributors.role,
        personName: bookContributors.personName,
        sequenceNumber: bookContributors.sequenceNumber,
      })
      .from(bookContributors)
      .where(inArray(bookContributors.bookId, ids))
      .orderBy(bookContributors.sequenceNumber),

    db
      .select({
        bookId: bookGenres.bookId,
        name: genres.name,
        slug: genres.slug,
      })
      .from(bookGenres)
      .innerJoin(genres, eq(genres.id, bookGenres.genreId))
      .where(inArray(bookGenres.bookId, ids)),

    db
      .select({
        bookId: bookPrices.bookId,
        priceType: bookPrices.priceType,
        priceAmount: bookPrices.priceAmount,
        currencyCode: bookPrices.currencyCode,
      })
      .from(bookPrices)
      .where(inArray(bookPrices.bookId, ids)),
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

export const booksService = {
  async list(opts: ListBooksOptions): Promise<{ books: BookListItem[]; total: number }> {
    const where = buildWhereClause(opts, true);

    // Run data + count queries in parallel
    const [rows, [countRow]] = await Promise.all([
      db
        .select(LIST_COLUMNS)
        .from(books)
        .where(where)
        .orderBy(
          opts.q
            ? sql`ts_rank(${books.searchVector}, plainto_tsquery('english', ${opts.q})) DESC`
            : books.updatedAt,
        )
        .limit(opts.limit)
        .offset(opts.offset),

      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(books)
        .where(where),
    ]);

    // Trigram fallback — if FTS returned nothing and a query was provided, try similarity on title
    if (rows.length === 0 && opts.q) {
      const trigramWhere = buildWhereClause({ ...opts, q: undefined }, false);
      const [fallbackRows, [fallbackCount]] = await Promise.all([
        db
          .select(LIST_COLUMNS)
          .from(books)
          .where(
            trigramWhere
              ? and(trigramWhere, sql`${books.title} % ${opts.q}`)
              : sql`${books.title} % ${opts.q}`,
          )
          .orderBy(sql`similarity(${books.title}, ${opts.q}) DESC`)
          .limit(opts.limit)
          .offset(opts.offset),

        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(books)
          .where(
            trigramWhere
              ? and(trigramWhere, sql`${books.title} % ${opts.q}`)
              : sql`${books.title} % ${opts.q}`,
          ),
      ]);

      const relations = await attachRelationsToList(fallbackRows);
      return {
        books: fallbackRows.map((r) => ({ ...r, ...relations.get(r.id)! })),
        total: fallbackCount?.count ?? 0,
      };
    }

    const relations = await attachRelationsToList(rows);
    return {
      books: rows.map((r) => ({ ...r, ...relations.get(r.id)! })),
      total: countRow?.count ?? 0,
    };
  },

  async suggestions(q: string, limit: number): Promise<SuggestionItem[]> {
    const prefix = q + '%';
    const wordPrefix = '% ' + q + '%';

    // Three-tier match, all using the GIN trigram index on title:
    //   0 — title starts with q              (e.g. "Harr" → "Harry Potter...")
    //   1 — a word in the title starts with q (e.g. "Pot"  → "Harry Potter...")
    //   2 — word_similarity > 0.3             (e.g. "Haary" → "Harry Potter...")
    // Within each tier, rank by word_similarity descending.
    const rows = await db
      .select({
        id: books.id,
        title: books.title,
        subtitle: books.subtitle,
        isbn13: books.isbn13,
        productForm: books.productForm,
        coverUrl: books.coverUrl,
      })
      .from(books)
      .where(
        sql`
          ${books.title} ILIKE ${prefix}
          OR ${books.title} ILIKE ${wordPrefix}
          OR word_similarity(${q}, ${books.title}) > 0.3
        `,
      )
      .orderBy(
        sql`
          CASE
            WHEN ${books.title} ILIKE ${prefix}     THEN 0
            WHEN ${books.title} ILIKE ${wordPrefix} THEN 1
            ELSE 2
          END
        `,
        sql`word_similarity(${q}, ${books.title}) DESC`,
      )
      .limit(limit);

    if (rows.length === 0) return [];

    // Batch-fetch authors (A01 role only) for matched books
    const ids = rows.map((r) => r.id);
    const contributors = await db
      .select({
        bookId: bookContributors.bookId,
        personName: bookContributors.personName,
      })
      .from(bookContributors)
      .where(
        sql`${bookContributors.bookId} = ANY(${sql.raw(`ARRAY[${ids.join(',')}]::int[]`)})
            AND ${bookContributors.role} = 'A01'`,
      )
      .orderBy(bookContributors.sequenceNumber);

    const authorMap = new Map<number, string[]>();
    for (const c of contributors) {
      if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
      if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
    }

    return rows.map((r) => ({
      ...r,
      authors: authorMap.get(r.id) ?? [],
    }));
  },

  async getById(id: number): Promise<BookDetail | null> {
    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) return null;

    const [contributors, genreRows, priceRows, subjects] = await Promise.all([
      db
        .select({
          role: bookContributors.role,
          personName: bookContributors.personName,
          sequenceNumber: bookContributors.sequenceNumber,
        })
        .from(bookContributors)
        .where(eq(bookContributors.bookId, id))
        .orderBy(bookContributors.sequenceNumber),

      db
        .select({ name: genres.name, slug: genres.slug })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(eq(bookGenres.bookId, id)),

      db
        .select({
          priceType: bookPrices.priceType,
          priceAmount: bookPrices.priceAmount,
          currencyCode: bookPrices.currencyCode,
        })
        .from(bookPrices)
        .where(eq(bookPrices.bookId, id)),

      db
        .select({
          schemeIdentifier: bookSubjects.schemeIdentifier,
          subjectCode: bookSubjects.subjectCode,
          subjectHeadingText: bookSubjects.subjectHeadingText,
          isMainSubject: bookSubjects.isMainSubject,
        })
        .from(bookSubjects)
        .where(eq(bookSubjects.bookId, id)),
    ]);

    return {
      id: book.id,
      isbn13: book.isbn13,
      recordReference: book.recordReference,
      title: book.title,
      subtitle: book.subtitle,
      shortDescription: book.shortDescription,
      longDescription: book.longDescription,
      publisherName: book.publisherName,
      imprintName: book.imprintName,
      productForm: book.productForm,
      publicationDate: book.publicationDate,
      publishingStatus: book.publishingStatus,
      availabilityCode: book.availabilityCode,
      editionNumber: book.editionNumber,
      pageCount: book.pageCount,
      heightMm: book.heightMm,
      widthMm: book.widthMm,
      thicknessMm: book.thicknessMm,
      weightGr: book.weightGr,
      countryOfManufacture: book.countryOfManufacture,
      countryOfPublication: book.countryOfPublication,
      returnsCode: book.returnsCode,
      orderTime: book.orderTime,
      coverUrl: book.coverUrl,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
      contributors,
      genres: genreRows,
      prices: priceRows,
      subjects,
    };
  },
};
