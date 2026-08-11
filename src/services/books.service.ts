import { createHash } from 'crypto';
import { eq, sql, and, ilike, inArray, asc, desc, gt, notInArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
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
  type Book,
  type BookContributor,
  type Genre,
  type BookSubject,
  type BookPrice,
} from '../db/schema';
import { dedupeByTitle, dedupeByTitleAndSubtitle } from '../lib/dedupe';
import {
  buildWorkExclusionCondition,
  filterExcludedWorks,
  getUserExclusions,
} from '../lib/exclusions';
import { redis } from '../lib/redis';
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';
import { TRENDING_SCORED_TYPES, trendingScoreSql } from './interactions.service';

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
// Feeds (trending/personalized/similar) over-fetch a candidate pool larger than the
// requested `limit` so that deduping same-titled editions (see dedupeByTitle) still
// leaves enough distinct titles to fill the requested count.
const FEED_POOL_MULTIPLIER = 3;
const FEED_POOL_MAX = 100;
// Trending and "you may also like" cache one shared list (per limit, per book)
// and serve it to every viewer, so a viewer's rejected books are filtered out
// after the cache read. This is how many spare rows are cached beyond the
// requested limit to absorb that filtering — enough for a typical rejection
// list without inflating every cache entry for the majority of users who have
// rejected nothing.
const FEED_EXCLUSION_HEADROOM = 10;
// list()'s ?dedupe=true over-fetches this many extra rows per page so that collapsing
// same-titled editions still tends to leave a full page of distinct titles. Unlike the feeds
// above, list() doesn't scale this with the requested limit (up to 50) — a fixed headroom
// keeps the plain-browse path's cheap LIMIT/OFFSET scan cheap regardless of how deep the
// page is, at the cost of not *guaranteeing* a full page back when duplicate editions are
// unusually clustered at a given offset.
const DEDUPE_POOL_HEADROOM = 20;
// Hard ceiling on how many rows a search's result count is willing to examine. Counting
// a search's full match set is unbounded work — on the production catalogue (1.1M rows)
// a single common term like "the" matches ~322k rows, and EXPLAIN (ANALYZE, BUFFERS)
// measured ~900MB of disk reads for one such count against a ~4GB-RAM instance. Past
// this cap the count stops early and reports the cap as a floor ("1000+"), which callers
// distinguish via `totalIsApproximate`. Comfortably above the max page size (50) so
// ordinary pagination never notices.
const SEARCH_COUNT_CAP = 1000;
// Ceiling on how many author matches a search will pull from book_contributors before
// ranking them — see buildAuthorMatchCondition. Sized well above any real author's
// catalogue (the most prolific names in the catalogue are in the low hundreds of titles)
// so it only ever truncates genuinely ambiguous fragments, where the rows past the cap
// were never going to be shown anyway.
const AUTHOR_MATCH_LIMIT = 5000;

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
  // Opt-in: collapses same-titled editions down to the best one (cover > complete dataset >
  // newest publication date > has a price). See dedupeByTitle in lib/dedupe.ts.
  dedupe?: boolean;
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

// Which side of the catalogue a typeahead query is matched against. 'all' (the default)
// matches both and merges the results; the single-sided values exist for callers that
// already know what the user is looking for, such as a dedicated author filter.
export type SuggestionType = 'all' | 'title' | 'author';

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

// TrendingBookItem plus the fields dedupeByTitle needs to pick the best of several
// same-titled editions — fetched alongside the public fields but stripped before a
// feed's rows are cached/returned, since none of them are part of the public shape.
interface FeedScoringRow extends TrendingBookItem {
  shortDescription: string | null;
  availabilityCode: string | null;
  genreCount: number;
  hasPrice: boolean;
}

function stripFeedScoring(row: FeedScoringRow): TrendingBookItem {
  const { shortDescription: _shortDescription, availabilityCode: _availabilityCode, genreCount: _genreCount, hasPrice: _hasPrice, ...item } = row;
  return item;
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

// Matches books by their author's name, as an *uncorrelated* subquery over a
// bounded candidate set.
//
// Both properties are load-bearing, and replace an earlier shape that had
// neither:
//   - Uncorrelated: the previous version ranked author matches with a
//     correlated subquery per candidate row (a MIN(CASE ...) over
//     book_contributors evaluated once per book). Postgres has to run that for
//     every row it considers before it can sort and apply LIMIT/OFFSET, which
//     is survivable for the small fixed pool in suggestions() but not for a
//     paginated list. Ranking now comes from the branch's own ORDER BY (see
//     buildAuthorMatchOrderBy) so the subquery is evaluated once, as a hashed
//     SubPlan, no matter how many books it is checked against.
//   - Bounded: the inner LIMIT caps how many contributor rows can ever feed the
//     outer query, so a very common name fragment ("sm", "jo") costs the same as
//     a rare one. Without it, the outer sort is proportional to how popular the
//     name is — the same unbounded-work problem SEARCH_COUNT_CAP exists to
//     prevent on the count side.
//
// The two name tiers are separate UNION ALL branches, each with its own LIMIT, rather
// than one OR'd condition ranked by an ORDER BY CASE. The obvious version,
//
//     WHERE person_name ILIKE 'jo%' OR person_name ILIKE '% jo%'
//     ORDER BY CASE WHEN lower(person_name) LIKE 'jo%' THEN 0 ELSE 1 END
//     LIMIT 5000
//
// looks bounded but isn't: an ORDER BY over a computed expression can't be satisfied by
// any index, so Postgres has to consume and rank *every* matching contributor row before
// the LIMIT applies. Cost then scales with how common the fragment is — the same
// unbounded-work shape SEARCH_COUNT_CAP exists to prevent on the count side. Splitting
// them caps each branch independently: the sort at the end sees at most 2×the cap rows
// no matter how popular the name.
//
// The split also puts the prefix tier where an index can serve it. Branch 0 matches on
// lower(person_name) LIKE — plain LIKE, not ILIKE, since text_pattern_ops matches no
// other operator — which EXPLAIN confirms is an indexed range scan on
// idx_book_contributors_author_name_lower_pattern, the same trick
// buildFastTitlePrefixCondition uses on titles. Branch 1 is the trigram GIN's job.
//
// Ordering by tier decides which rows survive when the match set exceeds the cap: exact
// prefix matches ("chimamanda" → "Chimamanda Ngozi Adichie") win over word-prefix ones
// ("adichie" matching mid-name). Branch 1 doesn't repeat the plain-prefix arm — branch 0
// already covers it, and duplicate book ids cost nothing in an IN (...).
//
// 'broad' adds the fuzzy tiers (trigram word-similarity + FTS over the name) and is only
// used when the title branch has already fallen through to its own broad tier — i.e. when
// nothing cheaper matched at all. Callers must run it inside withWordSimilarityThreshold,
// since it uses the <% operator.
export function buildAuthorMatchSource(q: string, tier: 'cheap' | 'broad'): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  const fuzzy =
    tier === 'broad'
      ? q.length >= 3
        ? sql` OR ${q} <% bc.person_name
               OR to_tsvector('simple', bc.person_name) @@ plainto_tsquery('simple', ${q})`
        : sql` OR ${q} <% bc.person_name`
      : sql``;

  return sql`(
    (
      SELECT bc.book_id, 0 AS tier
      FROM book_contributors bc
      WHERE bc.role = 'A01'
        AND lower(bc.person_name) LIKE lower(${prefix})
      LIMIT ${AUTHOR_MATCH_LIMIT}
    )
    UNION ALL
    (
      SELECT bc.book_id, 1 AS tier
      FROM book_contributors bc
      WHERE bc.role = 'A01'
        AND bc.person_name IS NOT NULL
        AND (
          bc.person_name ILIKE ${wordPrefix}
          ${fuzzy}
        )
      LIMIT ${AUTHOR_MATCH_LIMIT}
    )
  )`;
}

// Membership-only form, for the count probe and for suggestions' author pool — anywhere
// the tier isn't needed for ranking. Where it is needed, see fetchAuthorBranch, which
// keeps the tier rather than throwing it away here.
export function buildAuthorMatchCondition(q: string, tier: 'cheap' | 'broad'): SQL {
  return sql`${books.id} IN (SELECT m.book_id FROM ${buildAuthorMatchSource(q, tier)} m)`;
}

// Resolves the author branch in two steps: rank matching book ids in SQL, then fetch
// those books through the normal typed select.
//
// The ranking can't be folded into the fetch's ORDER BY, because the tier lives in the
// subquery and referencing it per book row is the correlated-subquery shape that made the
// previous implementation slow. Ordering the fetch by title instead — which is what this
// did at first — throws the tier away entirely, and the result is that "Roderick Hunt"
// returns books by Constance Elizabeth Hunt and Roderic P. Quirk in alphabetical order
// while the author's own books sit thousands of rows down. The tier is the whole signal;
// it has to survive to the sort.
//
// Ids are over-fetched relative to the page because the filters (genre, availability, …)
// are applied to the books fetch, not to the ranking, so some ranked ids won't survive
// them. The multiplier is what keeps a filtered author search from under-filling its page.
// Everything here is bounded: at most branchLimit × OVERFETCH ids, sorted in memory.
const AUTHOR_ID_OVERFETCH = 5;

// Book ids whose author matched, mapped to their best (lowest) name-match tier.
//
// The ORDER BY has to be total, and has to be the same order the caller finally displays
// in — not just "tier first". `take` grows with the requested page, so page 2 asks for a
// larger sample than page 1; unless the ordering is deterministic and page-independent,
// the two samples are different arbitrary subsets of the tied rows and pages overlap. That
// is not hypothetical: with a bare ORDER BY MIN(tier), a prolific author's page 2 repeated
// a book from page 1, because 171 rows tied at tier 0 and Postgres was free to return any
// 30 of them. Ordering by (tier, title, id) makes every sample a prefix of the next one.
async function rankAuthorMatches(
  conn: Pick<typeof db, 'execute'>,
  q: string,
  tier: 'cheap' | 'broad',
  take: number,
): Promise<Map<number, number>> {
  const ranked = await conn.execute<{ id: number; tier: number }>(sql`
    SELECT m.book_id AS id, MIN(m.tier) AS tier
    FROM ${buildAuthorMatchSource(q, tier)} m
    JOIN ${books} ON ${books.id} = m.book_id
    GROUP BY m.book_id, ${books.title}
    ORDER BY MIN(m.tier), lower(${books.title}), m.book_id
    LIMIT ${take}
  `);

  const tierById = new Map<number, number>();
  for (const row of ranked as unknown as { id: number; tier: number }[]) {
    tierById.set(Number(row.id), Number(row.tier));
  }
  return tierById;
}

// Exact-prefix names first, then alphabetically within a tier. Must be the same total
// order rankAuthorMatches applies in SQL, including the id tiebreak — the ranking decides
// *which* rows a page can contain and this decides where they sit, so a disagreement
// between them puts a row on two pages or on none.
function byAuthorTierThenTitle<T extends { id: number; title: string }>(tierById: Map<number, number>) {
  return (a: T, b: T) => {
    const byTier = tierById.get(a.id)! - tierById.get(b.id)!;
    if (byTier !== 0) return byTier;
    const [at, bt] = [a.title.toLowerCase(), b.title.toLowerCase()];
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id - b.id;
  };
}

async function fetchAuthorBranch(
  conn: Pick<typeof db, 'select' | 'execute'>,
  opts: ListBooksOptions,
  q: string,
  tier: 'cheap' | 'broad',
  branchLimit: number,
) {
  const tierById = await rankAuthorMatches(conn, q, tier, branchLimit * AUTHOR_ID_OVERFETCH);
  if (tierById.size === 0) return [];

  const filters = buildWhereClause(opts);
  const ids = [...tierById.keys()];
  const rows = await conn
    .select(LIST_COLUMNS)
    .from(books)
    .where(filters ? and(inArray(books.id, ids), filters) : inArray(books.id, ids));

  rows.sort(byAuthorTierThenTitle(tierById));
  return rows.slice(0, branchLimit);
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
async function withWordSimilarityThreshold<T>(fn: (conn: Pick<typeof db, 'select' | 'execute'>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw('SET LOCAL pg_trgm.word_similarity_threshold = 0.3'));
    return fn(tx);
  });
}

// COUNT(*) over a search condition is unbounded work — it has to visit every matching
// row before it can report a number, which for a common term means hundreds of thousands
// of rows and hundreds of MB of disk reads (see SEARCH_COUNT_CAP). Counting inside a
// LIMIT'd subquery instead lets Postgres stop as soon as it has seen `cap` matches, so
// the cost is bounded by the cap rather than by how popular the search term is.
//
// Returns a value up to `cap`; reaching exactly `cap` means "at least this many" rather
// than an exact total, which is why callers pass cap+1 to tell the two cases apart.
async function countUpTo(where: SQL | undefined, cap: number): Promise<number> {
  const rows = await db.execute<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count FROM (SELECT 1 FROM ${books} WHERE ${where ?? sql`TRUE`} LIMIT ${cap}) t`,
  );
  return Number((rows as unknown as { count: number }[])[0]?.count ?? 0);
}

// Fetches one page of search results as two independently-bounded branches — books
// matched by title, then books matched by their author's name — merged title-first.
//
// Why two queries instead of one OR'd condition: the title branch's speed comes entirely
// from its ORDER BY matching an index's own ordering (see buildFastTitlePrefixOrderBy).
// A blended query has to rank title matches against author matches, which no single index
// can order, so Postgres would sort the whole candidate set — for a common prefix like
// "the" that is ~322k rows, the exact regression buildFastTitlePrefixCondition exists to
// avoid. Split in two, each branch keeps its own index-ordered plan and its own LIMIT, and
// the merge happens over at most 2×(offset+limit) rows in memory.
//
// Which branch leads depends on how well the title side actually matched, because the two
// branches carry very different confidence at different tiers:
//   - fast/cheap: the title branch is prefix or word-prefix matching, a strong signal, and
//     a query is more often a title than a name — so titles lead.
//   - broad: the title branch has fallen through to trigram/FTS, i.e. nothing matched a
//     title properly and it is returning fuzzy near-misses. An exact author-name match is
//     a far better answer than a fuzzy title one, so the author branch leads.
// Concretely, "Roderick Hunt" produced a page led by "Life of Sir Roderick I. Murchison"
// before this distinction existed, with the author's own books below the fold — the exact
// query this feature is for, answered with noise.
//
// Within a branch, no cross-branch relevance score is attempted: none of the indexes
// involved can supply one, and computing it would mean ranking the merged set in SQL,
// which is what makes the single-query version slow.
//
// The branches fetch from row 0 rather than pushing `offset` into SQL, since the offset
// applies to the merged sequence, not to either branch — so a deep page transfers
// offset+limit rows per branch. That is bounded by the max page size (50) and by
// SEARCH_COUNT_CAP making pagination past ~1000 rows meaningless for a search anyway.
async function fetchSearchPage(
  opts: ListBooksOptions,
  q: string,
  tier: 'fast' | 'cheap' | 'broad',
  titleWhere: SQL | undefined,
  titleOrderBy: (SQL | PgColumn)[],
  // The page size to fetch per branch — opts.limit normally, or opts.limit +
  // DEDUPE_POOL_HEADROOM when the caller is about to dedupe the merged result.
  pageSize: number,
) {
  const branchLimit = opts.offset + pageSize + 1;

  const titleQuery = (conn: Pick<typeof db, 'select'>) =>
    conn.select(LIST_COLUMNS).from(books).where(titleWhere).orderBy(...titleOrderBy).limit(branchLimit);

  // The author branch only reaches for its fuzzy tier when the title branch has already
  // fallen through to its own — i.e. nothing cheaper matched anywhere. Escalating the two
  // together keeps the expensive trigram/FTS path off every ordinary search.
  const authorQuery = (conn: Pick<typeof db, 'select' | 'execute'>) =>
    fetchAuthorBranch(conn, opts, q, tier === 'broad' ? 'broad' : 'cheap', branchLimit);

  let titleRows: Awaited<ReturnType<typeof titleQuery>>;
  let authorRows: Awaited<ReturnType<typeof authorQuery>>;
  if (tier === 'broad') {
    // Both branches use <% at this tier, so both need the threshold override — and it only
    // holds for the transaction, so they run inside one rather than in parallel.
    const pair = await withWordSimilarityThreshold(async (conn) => ({
      title: await titleQuery(conn),
      author: await authorQuery(conn),
    }));
    titleRows = pair.title;
    authorRows = pair.author;
  } else {
    [titleRows, authorRows] = await Promise.all([titleQuery(db), authorQuery(db)]);
  }

  // A book matching on both sides must appear once, at its leading branch's position.
  const ordered = tier === 'broad' ? [...authorRows, ...titleRows] : [...titleRows, ...authorRows];
  const seen = new Set<number>();
  const merged: typeof titleRows = [];
  for (const row of ordered) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }

  // One row beyond the page, so the caller can derive `hasMore` without a second query.
  return merged.slice(opts.offset, branchLimit);
}

// ── Public service ────────────────────────────────────────────────────────────

export const booksService = {
  async list(
    opts: ListBooksOptions,
  ): Promise<{ books: BookListItem[]; total: number; hasMore: boolean; totalIsApproximate: boolean }> {
    // v2: the cached row payload changed shape (now { rows, hasMore }) and the cached
    // count is now capped for searches — bumping the prefix retires incompatible entries
    // rather than letting them deserialize into the wrong shape.
    // v3: searches now match on author name too, so the same key yields a different (and
    // larger) result set than anything cached under v2.
    // v4: opts now includes `dedupe`, which changes both which rows come back and how many
    // — every request now hashes it (even dedupe:false, since the schema always supplies a
    // default), so bumping avoids a generation of guaranteed-stale v3 lookups post-deploy.
    const rowsCacheKey = `books:list:v4:${createHash('sha256').update(JSON.stringify(opts)).digest('hex')}`;
    // Keyed only on the fields that affect the count (not limit/offset/sort) so every
    // page of the same filter — and every sort direction — shares one cached total.
    const countCacheKey = `books:count:v3:${createHash('sha256')
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
    //   - count: never runs against the broad tier at all, and is capped at
    //     SEARCH_COUNT_CAP. A search's exact total is unbounded work and was the single
    //     slowest thing this endpoint did — `GET /books?q=the alchemist` timed out in
    //     production (>25s) purely on its count, while the same query's rows come back in
    //     well under a second. The reported total is therefore a lower bound whenever
    //     `totalIsApproximate` is set; `hasMore` is what callers should paginate on.
    // The count is deliberately independent of the requested offset (it's cached under a
    // page-independent key — see countCacheKey), so every page of the same query agrees on
    // the same total instead of it drifting by whichever page computed it first.
    //
    // The tier probes below measure the *title* match set only, because that is what they
    // are choosing between — the author branch is fetched separately and has its own
    // bounded cost (see buildAuthorMatchCondition), so it never influences which title
    // tier is used. The reported total is a third, blended probe: it has to count books
    // matched by either side, and a title probe alone would undercount a search like
    // "chimamanda" to zero.
    let fastCount = 0;
    let cheapCount = 0;
    let blendedCount = 0;
    if (opts.q && (!cachedRows || cachedCount == null)) {
      const q = opts.q;
      // The two title probes are sequential (the second is only worth running if the first
      // didn't already hit the cap), but the blended probe doesn't depend on either — so it
      // overlaps them rather than adding its latency on top.
      const [titleCounts, blended] = await Promise.all([
        (async () => {
          const fast = await countUpTo(
            buildWhereClause(opts, buildFastTitlePrefixCondition(q)),
            SEARCH_COUNT_CAP + 1,
          );
          // Only worth widening to the cheap tier if the fast tier hasn't already hit the cap.
          const cheap =
            fast > SEARCH_COUNT_CAP
              ? 0
              : await countUpTo(
                  buildWhereClause(opts, buildTitlePrefixCondition(q)),
                  SEARCH_COUNT_CAP + 1,
                );
          return { fast, cheap };
        })(),
        countUpTo(
          buildWhereClause(
            opts,
            sql`(${buildTitlePrefixCondition(q)} OR ${buildAuthorMatchCondition(q, 'cheap')})`,
          ),
          SEARCH_COUNT_CAP + 1,
        ),
      ]);
      fastCount = titleCounts.fast;
      cheapCount = titleCounts.cheap;
      blendedCount = blended;
    }
    // blendedCount already counts the union of both branches, so it dominates the title-only
    // probes — max() rather than a sum, which would double-count books matching both.
    const searchMatchCount = Math.max(fastCount, cheapCount, blendedCount);

    type SearchTier = 'fast' | 'cheap' | 'broad';
    const pageEnd = opts.offset + opts.limit;
    // The broad tier is now reserved for searches the cheaper tiers can't answer *at all*
    // at this offset (in practice: typos and pure fuzzy matches). Previously any query
    // whose prefix matches couldn't fill a whole page fell through to it — which is why a
    // specific multi-word title like "the god of small things" (a handful of real
    // editions, nowhere near a 20-row page) hit the slowest path and timed out. Returning
    // that handful of genuine matches is both far faster and better ranked than padding
    // the page out with fuzzy near-misses.
    const rowsTier: SearchTier = opts.q
      ? fastCount >= pageEnd
        ? 'fast'
        : cheapCount > opts.offset
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

    // With dedupe on, over-fetch a headroom pool per page so collapsing same-titled
    // editions still tends to leave a full page — see DEDUPE_POOL_HEADROOM. Without it,
    // this is exactly opts.limit and every branch below reproduces prior behaviour.
    const overfetchLimit = opts.dedupe ? opts.limit + DEDUPE_POOL_HEADROOM : opts.limit;

    const pagePromise: Promise<{ rows: BookListItem[]; hasMore: boolean }> = cachedRows
      ? Promise.resolve(JSON.parse(cachedRows) as { rows: BookListItem[]; hasMore: boolean }).then((parsed) => {
          for (const b of parsed.rows) {
            b.createdAt = new Date(b.createdAt);
            b.updatedAt = new Date(b.updatedAt);
          }
          return parsed;
        })
      : (async () => {
          const fetched = opts.q
            ? await fetchSearchPage(opts, opts.q, rowsTier, rowsWhere, rowsOrderBy, overfetchLimit)
            : await db
                .select(LIST_COLUMNS)
                .from(books)
                .where(rowsWhere)
                .orderBy(...rowsOrderBy)
                // One row beyond the (possibly overfetched) page, so `hasMore` is known
                // without a second query — this is what callers should paginate on now
                // that `total` may be capped or, with dedupe, approximate.
                .limit(overfetchLimit + 1)
                .offset(opts.offset);

          const rawHasMore = fetched.length > overfetchLimit;
          const rawRows = rawHasMore ? fetched.slice(0, overfetchLimit) : fetched;

          const [relations, excerptMap, descriptionById] = await Promise.all([
            attachRelationsToList(rawRows),
            getExcerptsByIsbns(rawRows.map((r) => r.isbn13)),
            // Only needed for dedupe scoring — BookListItem never exposes it, and
            // fetching it for every plain page would undo the "keep payloads small"
            // reason LIST_COLUMNS leaves it out.
            opts.dedupe && rawRows.length > 0
              ? db
                  .select({ id: books.id, shortDescription: books.shortDescription })
                  .from(books)
                  .where(inArray(books.id, rawRows.map((r) => r.id)))
                  .then((rows) => new Map(rows.map((r) => [r.id, r.shortDescription])))
              : Promise.resolve(new Map<number, string | null>()),
          ]);
          const enriched = rawRows.map((r) => ({
            ...r,
            ...relations.get(r.id)!,
            excerpt: pickExcerpt(r.isbn13, excerptMap),
          }));

          let hasMore = rawHasMore;
          let result: BookListItem[];
          if (opts.dedupe) {
            const scored = enriched.map((r) => ({
              ...r,
              shortDescription: descriptionById.get(r.id) ?? null,
              genreCount: r.genres.length,
              hasPrice: r.prices.length > 0,
            }));
            const deduped = dedupeByTitle(scored);
            hasMore = hasMore || deduped.length > opts.limit;
            result = deduped.slice(0, opts.limit).map(({ shortDescription: _shortDescription, genreCount: _genreCount, hasPrice: _hasPrice, ...item }) => item);
          } else {
            result = enriched;
          }

          const page = { rows: result, hasMore };
          await redis.set(rowsCacheKey, JSON.stringify(page), 'EX', LIST_TTL);
          return page;
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
          // Searches never run a count query of their own — they reuse the capped tier
          // probes computed above, so a search's count can never be the slow part again.
          if (opts.q) {
            const total = Math.min(searchMatchCount, SEARCH_COUNT_CAP);
            await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
            return total;
          }
          // Filter-only browse (no q) keeps an exact count: it's already cached for
          // COUNT_TTL under a page-independent key, it wasn't implicated in the timeouts,
          // and capping it would make whole-catalogue pagination meaningless.
          const countQuery = (conn: Pick<typeof db, 'select'>) =>
            conn.select({ count: sql<number>`COUNT(*)::int` }).from(books).where(rowsWhere);
          const [countRow] = await countQuery(db);
          const total = countRow?.count ?? 0;
          await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
          return total;
        })();

    const [page, total] = await Promise.all([pagePromise, totalPromise]);
    // Derived rather than stored so it stays correct when `total` came from cache. `total`
    // counts raw rows, not distinct titles — computing an exact distinct-title count would
    // mean an unbounded GROUP BY over the same 1M+-row table SEARCH_COUNT_CAP exists to
    // avoid scanning, so dedupe forces this the same way a capped search count does: a
    // lower bound, with `hasMore` as the real pagination signal.
    const totalIsApproximate = (!!opts.q && total >= SEARCH_COUNT_CAP) || !!opts.dedupe;
    return { books: page.rows, total, hasMore: page.hasMore, totalIsApproximate };
  },

  async suggestions(q: string, limit: number, type: SuggestionType = 'all', dedupe = false): Promise<SuggestionItem[]> {
    // v3: results now depend on `dedupe` too (added below) — v2 entries predate the flag
    // and were always deduped, so they'd be wrongly served as the non-deduped default.
    const cacheKey = `suggestions:v3:${type}:${dedupe}:${createHash('sha256').update(`${q}:${limit}`).digest('hex')}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as SuggestionItem[];

    // Four-tier match (tiers 0–2 prefix/word-prefix/trigram, tier 3 FTS fallback), run
    // against the book's title and against its author's name as two independent pools
    // that are merged at the end:
    //   0 — starts with q              (e.g. "Harr"  → "Harry Potter..." / "Harriet Beecher")
    //   1 — a word starts with q       (e.g. "Pot"   → "Harry Potter..." / "Pottinger")
    //   2 — word_similarity > 0.3      (e.g. "Haary" → "Harry Potter..." / "Harry Styles")
    //   3 — FTS hit                    (title: description/subtitle; author: full name)
    //
    // Tiers 0-1 run first, alone — EXPLAIN ANALYZE against the live 1.1M-row
    // table showed the full four-tier OR'd condition forces Postgres to
    // materialize and rank every tier-2 (word_similarity) match before
    // limiting (tens of thousands of rows for a common query like "harry",
    // ~28s of execution time). Tiers 0-1 alone are index scans on the trigram
    // index (tens of ms) for most terms — and on the title side an even cheaper
    // tier-0-only step runs first (see buildFastTitlePrefixCondition): for very
    // common prefixes (e.g. "the", ~30% of the table) tiers 0-1's combined trigram
    // scan itself degrades to seconds, while the fast tier's indexed range scan on
    // idx_books_title_lower_pattern stays cheap regardless. The author side gets the
    // same protection from the bounded subquery in buildAuthorMatchCondition, whose
    // inner ordering is served by idx_book_contributors_person_name_lower_pattern.
    // Each step only reaches the next when the current one doesn't already fill the pool.
    const poolSize = Math.min(limit * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);
    // shortDescription/availabilityCode/publicationDate are plain columns on `books` (no
    // join, negligible cost) fetched for every request — they're only ever used for the
    // dedupe scoring below and stripped from `results` before it's cached/returned, so
    // callers that don't pass dedupe never see them.
    const selectColumns = {
      id: books.id,
      title: books.title,
      subtitle: books.subtitle,
      isbn13: books.isbn13,
      productForm: books.productForm,
      coverUrl: books.coverUrl,
      shortDescription: books.shortDescription,
      availabilityCode: books.availabilityCode,
      publicationDate: books.publicationDate,
    };

    type SuggestionRow = {
      id: number;
      title: string;
      subtitle: string | null;
      isbn13: string | null;
      productForm: string | null;
      coverUrl: string | null;
      shortDescription: string | null;
      availabilityCode: string | null;
      publicationDate: string | null;
    };
    const wantsTitle = type !== 'author';
    const wantsAuthor = type !== 'title';
    // Each step excludes what earlier steps already found, so a book can't occupy two
    // slots in the pool. notInArray rejects an empty list, hence the guard.
    const excluding = (rows: SuggestionRow[]): SQL | undefined =>
      rows.length > 0 ? notInArray(books.id, rows.map((r) => r.id)) : undefined;

    // Ranks author matches by name-match tier, then fetches those books — the same two-step
    // as fetchAuthorBranch, and for the same reason: ordering these by title alone would
    // discard the tier and bury the exact match the user typed.
    const authorSuggestionsFor = async (
      conn: Pick<typeof db, 'select' | 'execute'>,
      tier: 'cheap' | 'broad',
      exclude: SuggestionRow[],
      take: number,
    ): Promise<SuggestionRow[]> => {
      const tierById = await rankAuthorMatches(conn, q, tier, take * AUTHOR_ID_OVERFETCH);
      for (const row of exclude) tierById.delete(row.id);
      if (tierById.size === 0) return [];
      const rows = await conn
        .select(selectColumns)
        .from(books)
        .where(inArray(books.id, [...tierById.keys()]));
      return rows.sort(byAuthorTierThenTitle(tierById)).slice(0, take);
    };

    // The two sides are independent, so the cheap tier of each runs in one round trip
    // rather than one after the other.
    let [titlePool, authorPool]: [SuggestionRow[], SuggestionRow[]] = await Promise.all([
      wantsTitle
        ? db
            .select(selectColumns)
            .from(books)
            .where(buildFastTitlePrefixCondition(q))
            .orderBy(...buildFastTitlePrefixOrderBy())
            .limit(poolSize)
        : Promise.resolve([] as SuggestionRow[]),
      wantsAuthor ? authorSuggestionsFor(db, 'cheap', [], poolSize) : Promise.resolve([] as SuggestionRow[]),
    ]);

    // Neither the fast title tier nor the cheap author tier uses the <% trigram-similarity
    // operator, so neither needs withWordSimilarityThreshold — only the broad tier below does.
    if (wantsTitle && titlePool.length < poolSize) {
      const exclude = excluding(titlePool);
      const cheap = buildTitlePrefixCondition(q);
      const midRows = await db
        .select(selectColumns)
        .from(books)
        .where(exclude ? and(cheap, exclude) : cheap)
        .orderBy(...buildTitlePrefixOrderBy(q))
        .limit(poolSize - titlePool.length);
      titlePool = [...titlePool, ...midRows];
    }

    // How much each side found *before* the fuzzy tier is what decides ordering below, so
    // it has to be captured here, while the pools still contain only confident matches.
    const titleCheapCount = titlePool.length;
    const authorCheapCount = authorPool.length;

    // Broad (fuzzy/FTS) is a last resort for both sides — reached only when nothing
    // cheaper filled the pool, which in practice means typos and partial names.
    if (titlePool.length + authorPool.length < poolSize) {
      const shortfall = poolSize - (titlePool.length + authorPool.length);
      await withWordSimilarityThreshold(async (conn) => {
        if (wantsTitle) {
          const exclude = excluding([...titlePool, ...authorPool]);
          const broad = buildSearchCondition(q);
          titlePool = [
            ...titlePool,
            ...(await conn
              .select(selectColumns)
              .from(books)
              .where(exclude ? and(broad, exclude) : broad)
              .orderBy(...buildSearchOrderBy(q))
              .limit(shortfall)),
          ];
        }
        if (wantsAuthor) {
          authorPool = [
            ...authorPool,
            ...(await authorSuggestionsFor(conn, 'broad', [...titlePool, ...authorPool], shortfall)),
          ];
        }
      });
    }

    // Title-grouping (picking the best of several same-titled editions) only runs when the
    // caller opts in — plain id-overlap between the two branches still gets collapsed either
    // way, since that's the same book appearing twice, not different editions of a work.
    let titleRows: SuggestionRow[];
    let authorRows: SuggestionRow[];
    if (dedupe) {
      const poolIds = [...new Set([...titlePool, ...authorPool].map((r) => r.id))];
      const [genreCounts, priceRows] = poolIds.length > 0
        ? await Promise.all([
            db
              .select({ bookId: bookGenres.bookId, count: sql<number>`COUNT(*)::int` })
              .from(bookGenres)
              .where(inArray(bookGenres.bookId, poolIds))
              .groupBy(bookGenres.bookId),
            db.selectDistinct({ bookId: bookPrices.bookId }).from(bookPrices).where(inArray(bookPrices.bookId, poolIds)),
          ])
        : [[], []];
      const genreCountById = new Map(genreCounts.map((g) => [g.bookId, g.count]));
      const priceIds = new Set(priceRows.map((p) => p.bookId));
      const withScoring = (r: SuggestionRow) => ({
        ...r,
        genreCount: genreCountById.get(r.id) ?? 0,
        hasPrice: priceIds.has(r.id),
      });

      const dedupedTitle = dedupeByTitleAndSubtitle(titlePool.map(withScoring));
      const titleIds = new Set(dedupedTitle.map((r) => r.id));
      const dedupedAuthor = dedupeByTitleAndSubtitle(authorPool.map(withScoring)).filter((r) => !titleIds.has(r.id));
      titleRows = dedupedTitle;
      authorRows = dedupedAuthor;
    } else {
      const titleIds = new Set(titlePool.map((r) => r.id));
      titleRows = titlePool;
      authorRows = authorPool.filter((r) => !titleIds.has(r.id));
    }

    // Same rule as the paginated search (see fetchSearchPage): titles lead, unless nothing
    // matched a title with any confidence and the author side did. A fuzzy title match is
    // a guess; an exact author match is an answer. "Jennifer Dussling" put "Elizabeth
    // Jennings: 'The Inward War'" — a trigram near-miss on Jennings/Jennifer — above seven
    // of Dussling's own books before this was applied here too.
    const authorFirst = titleCheapCount === 0 && authorCheapCount > 0;

    // The trailing side still keeps a reserved share of the list rather than getting
    // whatever is left over. Without a reserve, a query whose leading side already fills
    // the pool pushes the other out entirely — so "king" would return books with "King" in
    // the title and never a Stephen King novel, which is the exact case this feature
    // exists for. A third is enough to stay visible without displacing the better match.
    const [lead, trail] = authorFirst ? [authorRows, titleRows] : [titleRows, authorRows];
    const trailQuota = Math.min(trail.length, Math.floor(limit / 3));
    const rows = [...lead.slice(0, limit - trailQuota), ...trail].slice(0, limit);

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

    const results = rows.map(({ shortDescription: _shortDescription, availabilityCode: _availabilityCode, publicationDate: _publicationDate, ...r }) => ({
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

  /**
   * Fetches books by id, **preserving the order of `ids`**.
   *
   * Written for ranked feeds (the bestseller chart) where the ranking is
   * computed elsewhere and the position of each row is the whole point — an
   * `IN (...)` lookup returns rows in whatever order the planner finds
   * convenient, which would silently scramble a chart.
   */
  async listByIds(ids: number[]): Promise<BookListItem[]> {
    if (ids.length === 0) return [];

    const rows = await db
      .select({
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
      })
      .from(books)
      .where(and(inArray(books.id, ids), eq(books.isRemoved, false)));

    const [relations, excerptMap] = await Promise.all([
      attachRelationsToList(rows),
      getExcerptsByIsbns(rows.map((row) => row.isbn13)),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids
      .map((id) => {
        const row = byId.get(id);
        if (!row) return null;
        return {
          ...row,
          ...(relations.get(id) ?? { contributors: [], genres: [], prices: [] }),
          excerpt: pickExcerpt(row.isbn13, excerptMap),
        } as BookListItem;
      })
      .filter((book): book is BookListItem => book !== null);
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

  /**
   * The global trending leaderboard — the same ranking for everybody, which is
   * what lets one cache entry serve all traffic.
   *
   * A signed-in viewer still never sees a book they rejected: like "you may
   * also like", the shared list is filtered per viewer after the cache read
   * rather than being computed per user. Anonymous callers get the list as-is.
   */
  async trending(limit: number, userId?: number): Promise<TrendingBookItem[]> {
    const cacheTarget = limit + FEED_EXCLUSION_HEADROOM;
    // v3: the cached value is a pool of cacheTarget items rather than exactly
    // `limit`, so per-viewer filtering has spare rows to eat. (v2 reweighted
    // scores per interaction type; v1 was the flat unweighted ranking.)
    const cacheKey = `trending:v3:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return applyUserExclusions(JSON.parse(cached) as TrendingBookItem[], userId, limit);
    }

    const since = new Date();
    since.setDate(since.getDate() - TRENDING_WINDOW_DAYS);

    const poolSize = Math.min(cacheTarget * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);

    // Aggregate interaction signals over the last 30 days into a ranked list of book
    // IDs. Weighting and time decay both live in trendingScoreSql — see
    // interactions.service.ts for why each action is worth what it's worth.
    const score = trendingScoreSql();

    const scored = await db
      .select({
        bookId: userInteractions.bookId,
        score: sql<number>`${score}::float`,
      })
      .from(userInteractions)
      .where(
        and(
          gt(userInteractions.createdAt, since),
          inArray(userInteractions.type, TRENDING_SCORED_TYPES),
        ),
      )
      .groupBy(userInteractions.bookId)
      .orderBy(sql`${score} DESC`)
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

    const [bookRows, contributors, genreRows, priceRows] = await Promise.all([
      db
        .select({
          id: books.id,
          title: books.title,
          subtitle: books.subtitle,
          coverUrl: books.coverUrl,
          isbn13: books.isbn13,
          productForm: books.productForm,
          publicationDate: books.publicationDate,
          shortDescription: books.shortDescription,
          availabilityCode: books.availabilityCode,
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

      db
        .selectDistinct({ bookId: bookPrices.bookId })
        .from(bookPrices)
        .where(inArray(bookPrices.bookId, bookIds)),
    ]);

    const excerptMap = await getExcerptsByIsbns(bookRows.map((b) => b.isbn13));

    const bookMap = new Map(
      bookRows.map((b) => [
        b.id,
        { ...b, contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], genreCount: 0, hasPrice: false, excerpt: pickExcerpt(b.isbn13, excerptMap) },
      ]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) {
      const entry = bookMap.get(g.bookId);
      if (entry) {
        entry.genres.push({ name: g.name, slug: g.slug });
        entry.genreCount++;
      }
    }
    for (const p of priceRows) {
      const entry = bookMap.get(p.bookId);
      if (entry) entry.hasPrice = true;
    }

    // Preserve the score-ordered sequence from bookIds
    const ordered = bookIds.map((id) => bookMap.get(id)).filter((b): b is FeedScoringRow => b !== undefined);
    const pool = dedupeByTitle(ordered).slice(0, cacheTarget).map(stripFeedScoring);

    // The pool is shared across all viewers; each one gets their own filtered
    // view of it.
    await redis.set(cacheKey, JSON.stringify(pool), 'EX', TRENDING_TTL);
    return applyUserExclusions(pool, userId, limit);
  },

  async personalized(userId: number, limit: number): Promise<TrendingBookItem[]> {
    const cacheKey = `personalized:v1:${userId}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as TrendingBookItem[];

    // Fetch the user's stored preference embedding and their exclusion set
    // (rejected books plus everything already on their shelf) in parallel —
    // independent queries, no need to serialize them.
    const [[prefs], exclusions] = await Promise.all([
      db
        .select({ preferenceEmbedding: userPreferences.preferenceEmbedding })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1),

      getUserExclusions(userId),
    ]);

    // No embedding yet (migration still in progress or user has no preferences)
    if (!prefs?.preferenceEmbedding) return [];

    const vectorLiteral = `[${prefs.preferenceEmbedding.join(',')}]`;

    const whereClause = and(
      sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${PERSONALIZED_SIMILARITY_THRESHOLD}`,
      exclusions.bookIds.length > 0 ? notInArray(books.id, exclusions.bookIds) : undefined,
      // Catches other editions of an excluded book, which the ID list above
      // can't see — the catalogue stores each format as its own row.
      buildWorkExclusionCondition(exclusions.works),
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
          shortDescription: books.shortDescription,
          availabilityCode: books.availabilityCode,
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
    const [contributors, genreRows, priceRows, excerptMap] = await Promise.all([
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

      db.selectDistinct({ bookId: bookPrices.bookId }).from(bookPrices).where(inArray(bookPrices.bookId, ids)),

      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    const bookMap = new Map(
      rows.map((b) => [
        b.id,
        { ...b, contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], genreCount: 0, hasPrice: false, excerpt: pickExcerpt(b.isbn13, excerptMap) },
      ]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) {
      const entry = bookMap.get(g.bookId);
      if (entry) {
        entry.genres.push({ name: g.name, slug: g.slug });
        entry.genreCount++;
      }
    }
    for (const p of priceRows) {
      const entry = bookMap.get(p.bookId);
      if (entry) entry.hasPrice = true;
    }

    // Preserve cosine similarity order from rows
    const ordered = rows.map((r) => bookMap.get(r.id)).filter((b): b is FeedScoringRow => b !== undefined);
    const results = dedupeByTitle(ordered).slice(0, limit).map(stripFeedScoring);

    await redis.set(cacheKey, JSON.stringify(results), 'EX', PERSONALIZED_TTL);
    return results;
  },

  /**
   * "You May Also Like" — books nearest the given book's embedding.
   *
   * The cache stays keyed on the book, not the viewer: one cached list serves
   * every user, which is what makes this cheap. Per-user rejections are
   * applied *after* the cache read instead, so a user never sees a book they
   * swiped away without turning the cache key into book × user.
   *
   * The trade for that is caching a slightly longer list than asked for
   * (FEED_EXCLUSION_HEADROOM) so filtering still tends to leave `limit`
   * results. A user who has rejected an unusual number of near-neighbours of
   * this particular book can still come up short — an acceptable outcome for a
   * secondary shelf, and strictly better than showing them the rejects.
   */
  async similar(bookId: number, limit: number, userId?: number): Promise<TrendingBookItem[]> {
    // Over-fetch target, so per-user filtering below has spare rows to eat.
    const cacheTarget = limit + FEED_EXCLUSION_HEADROOM;
    // v2: the cached value is now a pool of cacheTarget items rather than
    // exactly `limit`, so old v1 entries must not be read back.
    const cacheKey = `similar:v2:${bookId}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return applyUserExclusions(JSON.parse(cached) as TrendingBookItem[], userId, limit);
    }

    const [target] = await db
      .select({ embedding: books.embedding })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    // No embedding yet (migration still in progress)
    if (!target?.embedding) return [];

    const vectorLiteral = `[${target.embedding.join(',')}]`;

    const poolSize = Math.min(cacheTarget * FEED_POOL_MULTIPLIER, FEED_POOL_MAX);

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
          shortDescription: books.shortDescription,
          availabilityCode: books.availabilityCode,
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
    const [contributors, genreRows, priceRows, excerptMap] = await Promise.all([
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

      db.selectDistinct({ bookId: bookPrices.bookId }).from(bookPrices).where(inArray(bookPrices.bookId, ids)),

      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    const bookMap = new Map(
      rows.map((b) => [
        b.id,
        { ...b, contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], genreCount: 0, hasPrice: false, excerpt: pickExcerpt(b.isbn13, excerptMap) },
      ]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) {
      const entry = bookMap.get(g.bookId);
      if (entry) {
        entry.genres.push({ name: g.name, slug: g.slug });
        entry.genreCount++;
      }
    }
    for (const p of priceRows) {
      const entry = bookMap.get(p.bookId);
      if (entry) entry.hasPrice = true;
    }

    // Preserve cosine similarity order from rows
    const ordered = rows.map((r) => bookMap.get(r.id)).filter((b): b is FeedScoringRow => b !== undefined);
    const pool = dedupeByTitle(ordered).slice(0, cacheTarget).map(stripFeedScoring);

    // The pool is what gets cached and shared across users; the caller gets
    // their own filtered view of it.
    await redis.set(cacheKey, JSON.stringify(pool), 'EX', PERSONALIZED_TTL);
    return applyUserExclusions(pool, userId, limit);
  },
};

/**
 * Drops books the viewer has rejected from an already-built list, then trims
 * to `limit`. Filtering happens here rather than in SQL because the list is a
 * per-book cache entry shared across users — see booksService.similar.
 *
 * Anonymous callers have nothing to exclude and skip the lookup entirely.
 */
async function applyUserExclusions(
  items: TrendingBookItem[],
  userId: number | undefined,
  limit: number,
): Promise<TrendingBookItem[]> {
  if (userId === undefined) return items.slice(0, limit);

  const exclusions = await getUserExclusions(userId);
  return filterExcludedWorks(items, exclusions).slice(0, limit);
}
