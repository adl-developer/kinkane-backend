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
import { dedupeByTitle, dedupeByTitleAndSubtitle } from '../lib/dedupe';
import { redis } from '../lib/redis';
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';

const BOOK_DETAIL_TTL    = 60 * 60;    // 1 hour
const LIST_TTL           = 5 * 60;     // 5 minutes
// COUNT(*) over the books table is the expensive part of a list query (full/near-full
// scan on 1M+ rows) while the row-fetch itself is a cheap indexed lookup. The total only
// depends on the filter fields (not limit/offset/sort), and barely changes minute to
// minute, so it's cached far longer than the rows and under its own filter-only key —
// see countCacheKey — instead of being recomputed on every LIST_TTL expiry.
const COUNT_TTL          = 30 * 60;    // 30 minutes
const SUGGESTIONS_TTL    = 5 * 60;     // 5 minutes
const TRENDING_TTL       = 60 * 60;    // 1 hour
const PERSONALIZED_TTL   = 60 * 60;    // 1 hour
const PERSONALIZED_SIMILARITY_THRESHOLD = 0.5;
// HNSW default ef_search (40) is below our pool sizes (up to FEED_POOL_MAX),
// which would silently drop recall on the <=> ANN queries. Widen it per-query.
const HNSW_EF_SEARCH = 150;
const TRENDING_WINDOW_DAYS = 30;
const TRENDING_INTERACTION_TYPES = ['view', 'wishlist', 'chosen_from_recommendation'] as const;
// Feeds (trending/personalized/similar) over-fetch a candidate pool larger than the
// requested `limit` so that deduping same-titled editions (see dedupeByTitle) still
// leaves enough distinct titles to fill the requested count.
const FEED_POOL_MULTIPLIER = 3;
const FEED_POOL_MAX = 100;
// Above this many cheap-tier (prefix) matches, list()'s search path reports the cheap
// count as-is instead of paying for an exact broad-tier count — see the cheap-first
// comment in list(). Comfortably above the max page size (50) so normal pagination
// depth doesn't force a fallback, while still being small enough that reaching it
// means the term is common enough for an exact count to be expensive.
const SEARCH_COUNT_THRESHOLD = 500;

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

  // Uses the <% operator, not word_similarity() as a plain function call —
  // pg_trgm's GIN index only recognizes the operator form for word-similarity
  // filtering. Its cutoff comes from the pg_trgm.word_similarity_threshold GUC
  // (set to 0.3 database-wide in setup.ts) rather than a literal argument here.
  return sql`(
    ${books.title} ILIKE ${prefix}
    OR ${books.title} ILIKE ${wordPrefix}
    OR ${q} <% ${books.title}
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
        OR ${q} <% bc.person_name
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

// Tiers 0-1 only (exact/word prefix) — both are backed directly by the trigram
// GIN index as index scans (confirmed via EXPLAIN: low tens of ms each, even on
// the full books table). This is deliberately a subset of buildSearchCondition,
// used to try the cheap match first — see the tiered fetch in suggestions() —
// before ever reaching for the expensive tier-2/3 (word_similarity/FTS) scan,
// which forces Postgres to materialize and rank every fuzzy-matching row in
// the table before it can apply a LIMIT.
function buildTitlePrefixCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  return sql`(${books.title} ILIKE ${prefix} OR ${books.title} ILIKE ${wordPrefix})`;
}

function buildTitlePrefixOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  return [sql`CASE WHEN ${books.title} ILIKE ${prefix} THEN 0 ELSE 1 END`, asc(books.title)];
}

// Backed by idx_books_title_lower_pattern (see setup.ts) — a functional btree on
// lower(title) using text_pattern_ops. Unlike buildTitlePrefixCondition, this gives
// Postgres a genuine indexed range scan for a prefix match, with cost independent of
// how common the prefix is. buildTitlePrefixCondition's ILIKE (backed by the trigram
// GIN index) degrades badly for very common prefixes — e.g. "the" matches ~30% of the
// 1.1M-row table, and EXPLAIN ANALYZE showed Postgres falling back to a lossy bitmap
// scan that rereads and rechecks hundreds of thousands of heap pages (~4.3s measured).
// Must use plain LIKE (not ILIKE) with both sides lowercased — text_pattern_ops only
// matches that exact operator/expression shape.
//
// Deliberately narrower than buildTitlePrefixCondition (prefix only, no word-prefix) —
// see the tiered fetch in list()/suggestions() for why this can stand in for it when it
// alone already has enough matches: its rows are exactly buildTitlePrefixCondition's
// tier-0 case, which always sorts ahead of its tier-1 (word-prefix) rows, so if tier-0
// alone already fills the requested window, no tier-1 row would have appeared in it
// anyway.
function buildFastTitlePrefixCondition(q: string): SQL {
  const prefix = q + '%';
  return sql`lower(${books.title}) LIKE lower(${prefix})`;
}

// Must order by lower(title) — the same expression the index is built on — not title
// itself. EXPLAIN ANALYZE confirmed that ordering by plain title makes Postgres discard
// idx_books_title_lower_pattern entirely (the index's order doesn't satisfy that ORDER
// BY) in favor of idx_books_title, which is case-sensitive: matches for a common prefix
// like "the" are scattered across its entire keyspace ("The", "the", "THE" sort nowhere
// near each other), so it degenerates into scanning ~800k rows one at a time (70s+
// measured) — the exact regression this index exists to avoid.
function buildFastTitlePrefixOrderBy(): SQL[] {
  return [sql`lower(${books.title})`];
}

// Same cheap-tier-only shape as buildTitlePrefixCondition, applied to author name.
function buildAuthorPrefixCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  return sql`${books.id} IN (
    SELECT bc.book_id FROM book_contributors bc
    WHERE bc.role = 'A01'
      AND bc.person_name IS NOT NULL
      AND (bc.person_name ILIKE ${prefix} OR bc.person_name ILIKE ${wordPrefix})
  )`;
}

function buildAuthorPrefixOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  return [
    sql`(
      SELECT MIN(CASE WHEN bc.person_name ILIKE ${prefix} THEN 0 ELSE 1 END)
      FROM book_contributors bc
      WHERE bc.book_id = ${books.id} AND bc.role = 'A01'
    )`,
  ];
}

// Cheap tier for authorSuggestions()'s grouped-by-name query — prefix/word-prefix
// directly on person_name, same rationale as buildTitlePrefixCondition.
function buildPersonNamePrefixCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  return sql`(${bookContributors.personName} ILIKE ${prefix} OR ${bookContributors.personName} ILIKE ${wordPrefix})`;
}

function buildPersonNamePrefixOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  return [sql`CASE WHEN ${bookContributors.personName} ILIKE ${prefix} THEN 0 ELSE 1 END`];
}

// `searchCondition` is threaded in separately (rather than built from opts.q here) so
// callers can swap the cheap prefix-only tier in for the expensive full tier — see the
// cheap-first strategy in list() — while still sharing the same genre/availability/etc.
// filters.
function buildWhereClause(opts: ListBooksOptions, searchCondition?: SQL): SQL | undefined {
  const conditions: SQL[] = [];

  if (searchCondition) {
    conditions.push(searchCondition);
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

// The `<%` word-similarity operator (buildSearchCondition, buildAuthorBookSearchCondition,
// and authorSuggestions' inline condition) reads its cutoff from the
// pg_trgm.word_similarity_threshold GUC rather than a literal argument — it
// defaults to 0.6, stricter than the 0.3 these queries were written against.
// SET LOCAL scopes the override to just the wrapped query, inside a
// transaction — a bare SET would stick to the pooled connection and leak
// into unrelated queries reusing it afterward.
async function withWordSimilarityThreshold<T>(fn: (conn: Pick<typeof db, 'select'>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw('SET LOCAL pg_trgm.word_similarity_threshold = 0.3'));
    return fn(tx);
  });
}

// ── Public service ────────────────────────────────────────────────────────────

export const booksService = {
  async list(opts: ListBooksOptions): Promise<{ books: BookListItem[]; total: number }> {
    const rowsCacheKey = `books:list:${createHash('sha256').update(JSON.stringify(opts)).digest('hex')}`;
    // Keyed only on the fields that affect the count (not limit/offset/sort) so every
    // page of the same filter — and every sort direction — shares one cached total.
    const countCacheKey = `books:count:${createHash('sha256')
      .update(
        JSON.stringify({
          q: opts.q,
          genre: opts.genre,
          availability: opts.availability,
          productForm: opts.productForm,
          publishingStatus: opts.publishingStatus,
          publisher: opts.publisher,
        }),
      )
      .digest('hex')}`;

    const [cachedRows, cachedCount] = await Promise.all([
      redis.get(rowsCacheKey),
      redis.get(countCacheKey),
    ]);

    // When a search query is present, probe increasingly broad tiers — cheapest first —
    // stopping as soon as one has enough to answer the question at hand, since each
    // broader tier costs meaningfully more:
    //   1. fast  — buildFastTitlePrefixCondition: indexed range scan on
    //      idx_books_title_lower_pattern, cost independent of how common the prefix is.
    //   2. cheap — buildTitlePrefixCondition (prefix + word-prefix): trigram GIN, cheap
    //      for most terms but degrades badly for very common ones (see its comment).
    //   3. broad — buildSearchCondition (+ trigram-similarity + FTS): expensive, forces
    //      materializing and ranking every fuzzy match before a LIMIT can apply.
    // Neither the fast nor cheap tier uses the <% trigram-similarity operator, so neither
    // probe needs withWordSimilarityThreshold — only the broad tier does.
    //
    // rows and count are decided independently, since they have different correctness
    // requirements:
    //   - rows: a tier is used only once it has enough matches to fill the requested page
    //     (offset + limit); a request deep enough to outrun it still needs the next tier
    //     to fetch the right rows.
    //   - count: reported from the first tier that clears SEARCH_COUNT_THRESHOLD, rather
    //     than paying for an exact broad-tier COUNT(*). This is a known approximation (a
    //     lower bound — the true total may include additional matches from a broader
    //     tier) accepted for search terms common enough to make an exact count expensive.
    // Both checks are independent of the requested offset for the *count* decision (it's
    // cached under a page-independent key — see countCacheKey), so every page of the same
    // query agrees on the same total instead of it drifting by whichever page happened to
    // trigger the computation first.
    let fastCount = 0;
    let cheapCount = 0;
    if (opts.q && (!cachedRows || cachedCount == null)) {
      const fastWhere = buildWhereClause(opts, buildFastTitlePrefixCondition(opts.q));
      const [fastRow] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(books).where(fastWhere);
      fastCount = fastRow?.count ?? 0;

      if (fastCount < opts.offset + opts.limit || fastCount < SEARCH_COUNT_THRESHOLD) {
        const cheapWhere = buildWhereClause(opts, buildTitlePrefixCondition(opts.q));
        const [cheapRow] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(books).where(cheapWhere);
        cheapCount = cheapRow?.count ?? 0;
      }
    }

    type SearchTier = 'fast' | 'cheap' | 'broad';
    const rowsTier: SearchTier = opts.q
      ? fastCount >= opts.offset + opts.limit
        ? 'fast'
        : cheapCount >= opts.offset + opts.limit
          ? 'cheap'
          : 'broad'
      : 'broad';
    const countTier: SearchTier = opts.q
      ? fastCount >= SEARCH_COUNT_THRESHOLD
        ? 'fast'
        : cheapCount >= SEARCH_COUNT_THRESHOLD
          ? 'cheap'
          : 'broad'
      : 'broad';

    // When a search query is present, relevance ranking takes priority and sort is ignored.
    // Otherwise sort by title (asc/desc) when specified, falling back to updatedAt.
    const rowsWhere = opts.q
      ? buildWhereClause(
          opts,
          rowsTier === 'fast'
            ? buildFastTitlePrefixCondition(opts.q)
            : rowsTier === 'cheap'
              ? buildTitlePrefixCondition(opts.q)
              : buildSearchCondition(opts.q),
        )
      : buildWhereClause(opts);
    const rowsOrderBy = opts.q
      ? rowsTier === 'fast'
        ? buildFastTitlePrefixOrderBy()
        : rowsTier === 'cheap'
          ? buildTitlePrefixOrderBy(opts.q)
          : buildSearchOrderBy(opts.q)
      : opts.sort
        ? [opts.sort === 'desc' ? desc(books.title) : asc(books.title)]
        : [books.updatedAt];

    const booksPromise: Promise<BookListItem[]> = cachedRows
      ? Promise.resolve(JSON.parse(cachedRows) as BookListItem[]).then((parsed) => {
          for (const b of parsed) {
            b.createdAt = new Date(b.createdAt);
            b.updatedAt = new Date(b.updatedAt);
          }
          return parsed;
        })
      : (async () => {
          const rowsQuery = (conn: Pick<typeof db, 'select'>) =>
            conn
              .select(LIST_COLUMNS)
              .from(books)
              .where(rowsWhere)
              .orderBy(...rowsOrderBy)
              .limit(opts.limit)
              .offset(opts.offset);
          // <% only appears in `rowsWhere` when opts.q is set AND rowsTier resolved to
          // 'broad' — skip the transaction wrapper otherwise so the fast/cheap tiers
          // (and the common no-search browse path) keep their fully parallel dispatch.
          const rows = await (opts.q && rowsTier === 'broad' ? withWordSimilarityThreshold(rowsQuery) : rowsQuery(db));

          const [relations, excerptMap] = await Promise.all([
            attachRelationsToList(rows),
            getExcerptsByIsbns(rows.map((r) => r.isbn13)),
          ]);
          const result = rows.map((r) => ({
            ...r,
            ...relations.get(r.id)!,
            excerpt: pickExcerpt(r.isbn13, excerptMap),
          }));

          await redis.set(rowsCacheKey, JSON.stringify(result), 'EX', LIST_TTL);
          return result;
        })();

    // Without a search query, COUNT(*) is the expensive part of this query — a full (or
    // near-full) scan of a 1M+ row table — while the row fetch above is a cheap indexed
    // lookup. The total barely changes minute to minute, so it's cached far longer than
    // the rows and under the filter-only key above, instead of being recomputed on every
    // LIST_TTL expiry (which previously happened on every distinct limit/offset/sort combo
    // too).
    const totalPromise: Promise<number> = cachedCount != null
      ? Promise.resolve(parseInt(cachedCount, 10))
      : (async () => {
          if (opts.q && countTier !== 'broad') {
            const total = countTier === 'fast' ? fastCount : cheapCount;
            await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
            return total;
          }
          const countWhere = opts.q ? buildWhereClause(opts, buildSearchCondition(opts.q)) : rowsWhere;
          const countQuery = (conn: Pick<typeof db, 'select'>) =>
            conn.select({ count: sql<number>`COUNT(*)::int` }).from(books).where(countWhere);
          const [countRow] = await (opts.q ? withWordSimilarityThreshold(countQuery) : countQuery(db));
          const total = countRow?.count ?? 0;
          await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
          return total;
        })();

    const [resultBooks, total] = await Promise.all([booksPromise, totalPromise]);
    return { books: resultBooks, total };
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
    //
    // Tiers 0-1 run first, alone — EXPLAIN ANALYZE against the live 1.1M-row
    // table showed the full four-tier OR'd condition forces Postgres to
    // materialize and rank every tier-2 (word_similarity) match before
    // limiting (tens of thousands of rows for a common query like "harry",
    // ~28s of execution time). Tiers 0-1 alone are index scans on the trigram
    // index (tens of ms) for most terms — but for `type === 'title'`, an even
    // cheaper tier-0-only step runs first (see buildFastTitlePrefixCondition):
    // for very common prefixes (e.g. "the", ~30% of the table) tiers 0-1's
    // combined trigram scan itself degrades to seconds, while the fast tier's
    // indexed range scan on idx_books_title_lower_pattern stays cheap regardless.
    // There's no equivalent index for author names yet, so `type === 'author'`
    // goes straight to tiers 0-1. Each step only reaches the next when the
    // current one doesn't already fill the pool.
    const poolSize = Math.min(limit * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);
    const selectColumns = {
      id: books.id,
      title: books.title,
      subtitle: books.subtitle,
      isbn13: books.isbn13,
      productForm: books.productForm,
      coverUrl: books.coverUrl,
    };

    const cheapWhere = type === 'author' ? buildAuthorPrefixCondition(q) : buildTitlePrefixCondition(q);
    const cheapOrderBy = type === 'author' ? buildAuthorPrefixOrderBy(q) : buildTitlePrefixOrderBy(q);

    let pool: { id: number; title: string; subtitle: string | null; isbn13: string | null; productForm: string | null; coverUrl: string | null }[] = [];
    if (type === 'title') {
      pool = await db
        .select(selectColumns)
        .from(books)
        .where(buildFastTitlePrefixCondition(q))
        .orderBy(...buildFastTitlePrefixOrderBy())
        .limit(poolSize);
    }

    // Neither buildFastTitlePrefixCondition nor cheapWhere uses the <% trigram-similarity
    // operator, so neither needs withWordSimilarityThreshold — only the broad tier below does.
    if (pool.length < poolSize) {
      const excludeIds = pool.map((r) => r.id);
      const midWhere = excludeIds.length > 0 ? and(cheapWhere, notInArray(books.id, excludeIds)) : cheapWhere;
      const midRows = await db
        .select(selectColumns)
        .from(books)
        .where(midWhere)
        .orderBy(...cheapOrderBy)
        .limit(poolSize - pool.length);
      pool = [...pool, ...midRows];
    }

    if (pool.length < poolSize) {
      const broadWhere = type === 'author' ? buildAuthorBookSearchCondition(q) : buildSearchCondition(q);
      const broadOrderBy = type === 'author' ? buildAuthorBookSearchOrderBy(q) : buildSearchOrderBy(q);
      const excludeIds = pool.map((r) => r.id);

      const extra = await withWordSimilarityThreshold((conn) =>
        conn
          .select(selectColumns)
          .from(books)
          .where(excludeIds.length > 0 ? and(broadWhere, notInArray(books.id, excludeIds)) : broadWhere)
          .orderBy(...broadOrderBy)
          .limit(poolSize - pool.length),
      );
      pool = [...pool, ...extra];
    }

    const rows = dedupeByTitleAndSubtitle(pool).slice(0, limit);

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

    const selectColumns = {
      personName: bookContributors.personName,
      bookCount: sql<number>`COUNT(DISTINCT ${bookContributors.bookId})::int`,
    };
    const baseWhere = and(eq(bookContributors.role, 'A01'), sql`${bookContributors.personName} IS NOT NULL`);

    // Same tiered approach as suggestions() — try the cheap prefix/word-prefix
    // tier (index scan on the trigram index) first, and only fall through to
    // the expensive word_similarity/FTS tier if that doesn't fill `limit`.
    let rows = await withWordSimilarityThreshold((conn) =>
      conn
        .select(selectColumns)
        .from(bookContributors)
        .where(and(baseWhere, buildPersonNamePrefixCondition(q)))
        .groupBy(bookContributors.personName)
        .orderBy(...buildPersonNamePrefixOrderBy(q))
        .limit(limit),
    );

    if (rows.length < limit) {
      const excludeNames = rows.map((r) => r.personName).filter((n): n is string => n !== null);
      const extra = await withWordSimilarityThreshold((conn) =>
        conn
          .select(selectColumns)
          .from(bookContributors)
          .where(
            and(
              baseWhere,
              sql`(
                ${bookContributors.personName} ILIKE ${prefix}
                OR ${bookContributors.personName} ILIKE ${wordPrefix}
                OR ${q} <% ${bookContributors.personName}
                ${fts}
              )`,
              excludeNames.length > 0 ? notInArray(bookContributors.personName, excludeNames) : undefined,
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
          .limit(limit - rows.length),
      );
      rows = [...rows, ...extra];
    }

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

    // Fetch the user's stored preference embedding and their shelf (to exclude
    // from results) in parallel — independent queries, no need to serialize them.
    const [[prefs], shelfRows] = await Promise.all([
      db
        .select({ preferenceEmbedding: userPreferences.preferenceEmbedding })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1),

      db
        .select({ bookId: userBooks.bookId })
        .from(userBooks)
        .where(eq(userBooks.userId, userId)),
    ]);

    // No embedding yet (migration still in progress or user has no preferences)
    if (!prefs?.preferenceEmbedding) return [];

    const shelfIds = shelfRows.map((r) => r.bookId);

    const vectorLiteral = `[${prefs.preferenceEmbedding.join(',')}]`;

    const whereClause = and(
      sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${PERSONALIZED_SIMILARITY_THRESHOLD}`,
      shelfIds.length > 0 ? notInArray(books.id, shelfIds) : undefined,
    );

    const poolSize = Math.min(limit * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);

    // SET LOCAL scopes the raised ef_search to just this query, inside a
    // transaction — a bare SET would stick to the pooled connection and leak
    // into unrelated queries reusing it afterward.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`));
      return tx
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
    });

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

    // SET LOCAL scopes the raised ef_search to just this query, inside a
    // transaction — a bare SET would stick to the pooled connection and leak
    // into unrelated queries reusing it afterward.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`));
      return tx
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
    });

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
