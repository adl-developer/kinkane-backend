import { createHash } from 'crypto';
import { eq, sql, and, ilike, inArray, asc, desc, gt, notInArray, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  books,
  bookContributors,
  bookGenres,
  bookPrices,
  bookSubjects,
  genres,
  userInteractions,
  userPreferences,
  userBooks,
  type Book,
  type BookContributor,
  type Genre,
  type BookSubject,
  type BookPrice,
} from '../db/schema';
import { dedupeByTitle } from '../lib/dedupe';
import { redis } from '../lib/redis';
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';

const BOOK_DETAIL_TTL    = 60 * 60;    // 1 hour
const SUGGESTIONS_TTL    = 5 * 60;     // 5 minutes
const TRENDING_TTL       = 60 * 60;    // 1 hour
const PERSONALIZED_TTL   = 60 * 60;    // 1 hour
const PERSONALIZED_SIMILARITY_THRESHOLD = 0.5;
const TRENDING_WINDOW_DAYS = 30;
const TRENDING_INTERACTION_TYPES = ['view', 'wishlist', 'chosen_from_recommendation'] as const;
// Feeds (trending/personalized/similar) over-fetch a candidate pool larger than the
// requested `limit` so that deduping same-titled editions (see dedupeByTitle) still
// leaves enough distinct titles to fill the requested count.
const FEED_POOL_MULTIPLIER = 3;
const FEED_POOL_MAX = 100;

export interface ListBooksOptions {
  q?: string;
  genre?: string;
  availability?: string;
  productForm?: string;
  publishingStatus?: string;
  publisher?: string;
  sort?: 'asc' | 'desc';
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
  excerpt: BookExcerptInfo | null;
}

export interface SuggestionItem {
  id: number;
  title: string;
  subtitle: string | null;
  isbn13: string | null;
  productForm: string | null;
  coverUrl: string | null;
  authors: string[];
  excerpt: BookExcerptInfo | null;
}

export interface AuthorSuggestion {
  personName: string;
  bookCount: number;
}

export interface TrendingBookItem {
  id: number;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  isbn13: string | null;
  productForm: string | null;
  publicationDate: string | null;
  contributors: Pick<BookContributor, 'role' | 'personName' | 'sequenceNumber'>[];
  genres: Pick<Genre, 'name' | 'slug'>[];
  excerpt: BookExcerptInfo | null;
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

function buildSearchCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  // Tier 3 (FTS on description/subtitle) only fires for complete words
  const fts = q.length >= 3
    ? sql` OR ${books.searchVector} @@ plainto_tsquery('english', ${q})`
    : sql``;

  return sql`(
    ${books.title} ILIKE ${prefix}
    OR ${books.title} ILIKE ${wordPrefix}
    OR word_similarity(${q}, ${books.title}) > 0.3
    ${fts}
  )`;
}

function buildSearchOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  return [
    sql`CASE
      WHEN ${books.title} ILIKE ${prefix}     THEN 0
      WHEN ${books.title} ILIKE ${wordPrefix} THEN 1
      WHEN word_similarity(${q}, ${books.title}) > 0.3 THEN 2
      ELSE 3
    END`,
    sql`word_similarity(${q}, ${books.title}) DESC`,
    sql`ts_rank(${books.searchVector}, plainto_tsquery('english', ${q})) DESC`,
  ];
}

// Same four-tier matching scheme as buildSearchCondition, applied to author
// name instead of title, scoped down to a set of matching book IDs.
function buildAuthorBookSearchCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  const fts = q.length >= 3
    ? sql` OR to_tsvector('simple', bc.person_name) @@ plainto_tsquery('simple', ${q})`
    : sql``;

  return sql`${books.id} IN (
    SELECT bc.book_id FROM book_contributors bc
    WHERE bc.role = 'A01'
      AND bc.person_name IS NOT NULL
      AND (
        bc.person_name ILIKE ${prefix}
        OR bc.person_name ILIKE ${wordPrefix}
        OR word_similarity(${q}, bc.person_name) > 0.3
        ${fts}
      )
  )`;
}

function buildAuthorBookSearchOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  return [
    sql`(
      SELECT MIN(CASE
        WHEN bc.person_name ILIKE ${prefix}     THEN 0
        WHEN bc.person_name ILIKE ${wordPrefix} THEN 1
        WHEN word_similarity(${q}, bc.person_name) > 0.3 THEN 2
        ELSE 3
      END)
      FROM book_contributors bc
      WHERE bc.book_id = ${books.id} AND bc.role = 'A01'
    )`,
    sql`(
      SELECT MAX(word_similarity(${q}, bc.person_name))
      FROM book_contributors bc
      WHERE bc.book_id = ${books.id} AND bc.role = 'A01'
    ) DESC`,
  ];
}

function buildWhereClause(opts: ListBooksOptions): SQL | undefined {
  const conditions: SQL[] = [];

  if (opts.q) {
    conditions.push(buildSearchCondition(opts.q));
  }

  if (opts.genre) {
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
    const where = buildWhereClause(opts);
    // When a search query is present, relevance ranking takes priority and sort is ignored.
    // Otherwise sort by title (asc/desc) when specified, falling back to updatedAt.
    const orderBy = opts.q
      ? buildSearchOrderBy(opts.q)
      : opts.sort
        ? [opts.sort === 'desc' ? desc(books.title) : asc(books.title)]
        : [books.updatedAt];

    const [rows, [countRow]] = await Promise.all([
      db
        .select(LIST_COLUMNS)
        .from(books)
        .where(where)
        .orderBy(...orderBy)
        .limit(opts.limit)
        .offset(opts.offset),

      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(books)
        .where(where),
    ]);

    const [relations, excerptMap] = await Promise.all([
      attachRelationsToList(rows),
      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);
    return {
      books: rows.map((r) => ({
        ...r,
        ...relations.get(r.id)!,
        excerpt: pickExcerpt(r.isbn13, excerptMap),
      })),
      total: countRow?.count ?? 0,
    };
  },

  async suggestions(q: string, limit: number, type: 'title' | 'author' = 'title'): Promise<SuggestionItem[]> {
    const cacheKey = `suggestions:${type}:${createHash('sha256').update(`${q}:${limit}`).digest('hex')}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as SuggestionItem[];

    // Four-tier match (tiers 0–2 prefix/word-prefix/trigram, tier 3 FTS fallback),
    // applied to either the title or the author's name depending on `type`:
    //   0 — starts with q              (e.g. "Harr"  → "Harry Potter..." / "Harriet Beecher")
    //   1 — a word starts with q       (e.g. "Pot"   → "Harry Potter..." / "Pottinger")
    //   2 — word_similarity > 0.3      (e.g. "Haary" → "Harry Potter..." / "Harry Styles")
    //   3 — FTS hit                    (title: description/subtitle; author: full name)
    // Within each tier, ranked by word_similarity then ts_rank descending.
    const where = type === 'author' ? buildAuthorBookSearchCondition(q) : buildSearchCondition(q);
    const orderBy = type === 'author' ? buildAuthorBookSearchOrderBy(q) : buildSearchOrderBy(q);

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
      .where(where)
      .orderBy(...orderBy)
      .limit(limit);

    if (rows.length === 0) {
      await redis.set(cacheKey, '[]', 'EX', SUGGESTIONS_TTL);
      return [];
    }

    // Batch-fetch authors (A01 role only) for matched books
    const ids = rows.map((r) => r.id);
    const contributors = await db
      .select({
        bookId: bookContributors.bookId,
        personName: bookContributors.personName,
      })
      .from(bookContributors)
      .where(
        and(
          inArray(bookContributors.bookId, ids),
          eq(bookContributors.role, 'A01'),
        ),
      )
      .orderBy(bookContributors.sequenceNumber);

    const authorMap = new Map<number, string[]>();
    for (const c of contributors) {
      if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
      if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
    }

    const excerptMap = await getExcerptsByIsbns(rows.map((r) => r.isbn13));

    const results = rows.map((r) => ({
      ...r,
      authors: authorMap.get(r.id) ?? [],
      excerpt: pickExcerpt(r.isbn13, excerptMap),
    }));

    await redis.set(cacheKey, JSON.stringify(results), 'EX', SUGGESTIONS_TTL);
    return results;
  },

  async authorSuggestions(q: string, limit: number): Promise<AuthorSuggestion[]> {
    const cacheKey = `author-suggestions:${createHash('sha256').update(`${q}:${limit}`).digest('hex')}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as AuthorSuggestion[];

    const prefix = q + '%';
    const wordPrefix = '% ' + q + '%';
    const fts = q.length >= 3
      ? sql` OR to_tsvector('simple', ${bookContributors.personName}) @@ plainto_tsquery('simple', ${q})`
      : sql``;

    const rows = await db
      .select({
        personName: bookContributors.personName,
        bookCount: sql<number>`COUNT(DISTINCT ${bookContributors.bookId})::int`,
      })
      .from(bookContributors)
      .where(
        and(
          eq(bookContributors.role, 'A01'),
          sql`${bookContributors.personName} IS NOT NULL`,
          sql`(
            ${bookContributors.personName} ILIKE ${prefix}
            OR ${bookContributors.personName} ILIKE ${wordPrefix}
            OR word_similarity(${q}, ${bookContributors.personName}) > 0.3
            ${fts}
          )`,
        ),
      )
      .groupBy(bookContributors.personName)
      .orderBy(
        sql`CASE
          WHEN ${bookContributors.personName} ILIKE ${prefix}     THEN 0
          WHEN ${bookContributors.personName} ILIKE ${wordPrefix} THEN 1
          WHEN word_similarity(${q}, ${bookContributors.personName}) > 0.3 THEN 2
          ELSE 3
        END`,
        sql`word_similarity(${q}, ${bookContributors.personName}) DESC`,
      )
      .limit(limit);

    const results = rows.map((r) => ({ personName: r.personName as string, bookCount: r.bookCount }));

    await redis.set(cacheKey, JSON.stringify(results), 'EX', SUGGESTIONS_TTL);
    return results;
  },

  async getById(id: number): Promise<BookDetail | null> {
    const cacheKey = `book:detail:${id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      const detail = JSON.parse(cached) as BookDetail;
      detail.createdAt = new Date(detail.createdAt);
      detail.updatedAt = new Date(detail.updatedAt);
      return detail;
    }

    const [book] = await db.select().from(books).where(eq(books.id, id)).limit(1);
    if (!book) return null;

    const [contributors, genreRows, priceRows, subjects, excerptMap] = await Promise.all([
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

      getExcerptsByIsbns([book.isbn13]),
    ]);

    const detail: BookDetail = {
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
      excerpt: pickExcerpt(book.isbn13, excerptMap),
    };

    await redis.set(cacheKey, JSON.stringify(detail), 'EX', BOOK_DETAIL_TTL);
    return detail;
  },

  async trending(limit: number): Promise<TrendingBookItem[]> {
    const cacheKey = `trending:v1:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as TrendingBookItem[];

    const since = new Date();
    since.setDate(since.getDate() - TRENDING_WINDOW_DAYS);

    const poolSize = Math.min(limit * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);

    // Aggregate interaction signals over the last 30 days into a ranked list of book IDs
    const scored = await db
      .select({
        bookId: userInteractions.bookId,
        score: sql<number>`SUM(${userInteractions.weight})::float`,
      })
      .from(userInteractions)
      .where(
        and(
          gt(userInteractions.createdAt, since),
          inArray(userInteractions.type, [...TRENDING_INTERACTION_TYPES]),
        ),
      )
      .groupBy(userInteractions.bookId)
      .orderBy(sql`SUM(${userInteractions.weight}) DESC`)
      .limit(poolSize);

    let bookIds = scored.map((r) => r.bookId);

    // Fallback: top up the pool with recently published books if interactions haven't filled it
    if (bookIds.length < poolSize) {
      const exclude = bookIds.length > 0 ? bookIds : [-1];
      const fallback = await db
        .select({ id: books.id })
        .from(books)
        .where(
          and(
            sql`${books.id} NOT IN (${sql.join(exclude.map((id) => sql`${id}`), sql`, `)})`,
            sql`${books.publicationDate} IS NOT NULL`,
          ),
        )
        .orderBy(desc(books.publicationDate))
        .limit(poolSize - bookIds.length);

      bookIds = [...bookIds, ...fallback.map((r) => r.id)];
    }

    if (bookIds.length === 0) {
      await redis.set(cacheKey, '[]', 'EX', TRENDING_TTL);
      return [];
    }

    const [bookRows, contributors, genreRows] = await Promise.all([
      db
        .select({
          id: books.id,
          title: books.title,
          subtitle: books.subtitle,
          coverUrl: books.coverUrl,
          isbn13: books.isbn13,
          productForm: books.productForm,
          publicationDate: books.publicationDate,
        })
        .from(books)
        .where(inArray(books.id, bookIds)),

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
        .select({
          bookId: bookGenres.bookId,
          name: genres.name,
          slug: genres.slug,
        })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(inArray(bookGenres.bookId, bookIds)),
    ]);

    const excerptMap = await getExcerptsByIsbns(bookRows.map((b) => b.isbn13));

    const bookMap = new Map(bookRows.map((b) => [b.id, { ...b, contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], excerpt: pickExcerpt(b.isbn13, excerptMap) }]));
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) bookMap.get(g.bookId)?.genres.push({ name: g.name, slug: g.slug });

    // Preserve the score-ordered sequence from bookIds
    const ordered = bookIds.map((id) => bookMap.get(id)).filter((b): b is TrendingBookItem => b !== undefined);
    const results = dedupeByTitle(ordered).slice(0, limit);

    await redis.set(cacheKey, JSON.stringify(results), 'EX', TRENDING_TTL);
    return results;
  },

  async personalized(userId: number, limit: number): Promise<TrendingBookItem[]> {
    const cacheKey = `personalized:v1:${userId}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as TrendingBookItem[];

    // Fetch the user's stored preference embedding
    const [prefs] = await db
      .select({ preferenceEmbedding: userPreferences.preferenceEmbedding })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    // No embedding yet (migration still in progress or user has no preferences)
    if (!prefs?.preferenceEmbedding) return [];

    // Books already on the user's shelf — exclude from results
    const shelfRows = await db
      .select({ bookId: userBooks.bookId })
      .from(userBooks)
      .where(eq(userBooks.userId, userId));
    const shelfIds = shelfRows.map((r) => r.bookId);

    const vectorLiteral = `[${prefs.preferenceEmbedding.join(',')}]`;

    const whereClause = and(
      sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${PERSONALIZED_SIMILARITY_THRESHOLD}`,
      shelfIds.length > 0 ? notInArray(books.id, shelfIds) : undefined,
    );

    const poolSize = Math.min(limit * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);

    const rows = await db
      .select({
        id: books.id,
        title: books.title,
        subtitle: books.subtitle,
        coverUrl: books.coverUrl,
        isbn13: books.isbn13,
        productForm: books.productForm,
        publicationDate: books.publicationDate,
      })
      .from(books)
      .where(whereClause)
      .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
      .limit(poolSize);

    if (rows.length === 0) {
      await redis.set(cacheKey, '[]', 'EX', PERSONALIZED_TTL);
      return [];
    }

    const ids = rows.map((r) => r.id);
    const [contributors, genreRows, excerptMap] = await Promise.all([
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
        .select({ bookId: bookGenres.bookId, name: genres.name, slug: genres.slug })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(inArray(bookGenres.bookId, ids)),

      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    const bookMap = new Map(
      rows.map((b) => [b.id, { ...b, contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], excerpt: pickExcerpt(b.isbn13, excerptMap) }]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) bookMap.get(g.bookId)?.genres.push({ name: g.name, slug: g.slug });

    // Preserve cosine similarity order from rows
    const ordered = rows.map((r) => bookMap.get(r.id)).filter((b): b is TrendingBookItem => b !== undefined);
    const results = dedupeByTitle(ordered).slice(0, limit);

    await redis.set(cacheKey, JSON.stringify(results), 'EX', PERSONALIZED_TTL);
    return results;
  },

  async similar(bookId: number, limit: number): Promise<TrendingBookItem[]> {
    const cacheKey = `similar:v1:${bookId}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as TrendingBookItem[];

    const [target] = await db
      .select({ embedding: books.embedding })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    // No embedding yet (migration still in progress)
    if (!target?.embedding) return [];

    const vectorLiteral = `[${target.embedding.join(',')}]`;

    const poolSize = Math.min(limit * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);

    const rows = await db
      .select({
        id: books.id,
        title: books.title,
        subtitle: books.subtitle,
        coverUrl: books.coverUrl,
        isbn13: books.isbn13,
        productForm: books.productForm,
        publicationDate: books.publicationDate,
      })
      .from(books)
      .where(
        and(
          sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${PERSONALIZED_SIMILARITY_THRESHOLD}`,
          notInArray(books.id, [bookId]),
        ),
      )
      .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
      .limit(poolSize);

    if (rows.length === 0) {
      await redis.set(cacheKey, '[]', 'EX', PERSONALIZED_TTL);
      return [];
    }

    const ids = rows.map((r) => r.id);
    const [contributors, genreRows, excerptMap] = await Promise.all([
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
        .select({ bookId: bookGenres.bookId, name: genres.name, slug: genres.slug })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(inArray(bookGenres.bookId, ids)),

      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    const bookMap = new Map(
      rows.map((b) => [b.id, { ...b, contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], excerpt: pickExcerpt(b.isbn13, excerptMap) }]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) bookMap.get(g.bookId)?.genres.push({ name: g.name, slug: g.slug });

    // Preserve cosine similarity order from rows
    const ordered = rows.map((r) => bookMap.get(r.id)).filter((b): b is TrendingBookItem => b !== undefined);
    const results = dedupeByTitle(ordered).slice(0, limit);

    await redis.set(cacheKey, JSON.stringify(results), 'EX', PERSONALIZED_TTL);
    return results;
  },
};
