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
import { logger } from '../lib/logger';
import { normalisedNameSql, normaliseNameQuery } from '../lib/contributor-name';
import { redis } from '../lib/redis';
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';
import { TRENDING_SCORED_TYPES, trendingScoreSql } from './interactions.service';
import { availabilityService } from './commerce/availability.service';
import {
  buildShoppableCondition,
  buildShopBandCondition,
  buildPriceBoundsCondition,
  planShopBands,
  isSellableBand,
  SHOP_BAND,
  SHOP_BAND_ORDER,
  type ShopBand,
} from '../lib/shoppable';
import { toPresentment } from './commerce/pricing';
import { config } from '../config';

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

// How far the shop's band ladder counts before it stops caring. The band sizes exist to
// map a page offset onto the concatenated bands (see planShopBands), so they only have to
// be exact over the range a shopper can actually reach; past this the boundary is
// approximate and `hasMore` carries pagination, exactly as it does past SEARCH_COUNT_CAP.
// Capped rather than exact because these are two counts over a 2M-row catalogue and they
// are on the path of every shop page — the cap is what keeps a cold cache from paying for
// a full scan twice.
const SHOP_BAND_COUNT_CAP = 200_000;
// Ceiling on how many author matches a search will pull from book_contributors before
// ranking them — see buildAuthorMatchCondition. Sized well above any real author's
// catalogue (the most prolific names in the catalogue are in the low hundreds of titles)
// so it only ever truncates genuinely ambiguous fragments, where the rows past the cap
// were never going to be shown anyway.
const AUTHOR_MATCH_LIMIT = 5000;
// How many fuzzy candidates the broad tier will rank before picking a page.
//
// The broad tier's ranking expression — word_similarity() per row, then a sort — cannot be
// served by any index, so Postgres must evaluate it for every matching row before LIMIT can
// apply. That is fine when the fuzzy match set is small and catastrophic when it is not: a
// four-letter typo of a common word ("thhe") clears the 0.3 word-similarity threshold
// against 506,996 titles, a quarter of the catalogue, at which point the planner abandons
// the trigram index for a parallel sequential scan of all 1.98M rows. Measured on
// production: 93.5s and 6.5GB read from disk for one search.
//
// Capping the candidate pool decouples the cost from how dense the fuzzy neighbourhood is,
// the same way SEARCH_COUNT_CAP decouples the count from how common the term is. Sized well
// above any page the API can ask for (max offset + max page size), so the ranking still has
// a wide field to choose from.
//
// The tradeoff is real and worth stating plainly: the pool is the first rows Postgres
// happens to find, not the best ones, so for a very dense fuzzy match the top of the page
// is the best of a bounded sample rather than the best overall. That only affects searches
// where nothing matched by prefix or word-prefix at all — i.e. where every result is
// already a fuzzy guess — and it is the difference between a guess in a second and a guess
// in a minute and a half.
const BROAD_CANDIDATE_POOL = 2000;
// Wall-clock ceiling for the fuzzy tier. An ambiguous query — a typo, a mid-word fragment,
// anything that matched no title by prefix — must come back inside this, with whatever it
// managed to rank, rather than running to completion however long that takes.
const BROAD_TIME_BUDGET_MS = 5000;
// Pool sizes to try, smallest first. A statement_timeout cancels a query outright rather
// than returning partial rows, so "as much as fits in the budget" has to be built by
// attempting progressively wider pools and keeping the widest that finished. The first
// stage is sized to complete comfortably for every term measured on production (≤660ms
// warm), so there is nearly always a result in hand before the expensive attempt starts.
//
// The spread between them is the whole reason for staging: on "traning" the 500 pool takes
// 479ms and the 2000 pool 6.8s warm — and 14.6s cold — while on "thhe", "annd" and "boook"
// the 2000 pool lands in well under a second. A single fixed size is either too slow for
// the worst term or needlessly narrow for the rest; staging lets each query take the widest
// pool it can afford.
const BROAD_POOL_STAGES = [500, BROAD_CANDIDATE_POOL];
// Don't open a stage there is no realistic room to finish — it would burn the remainder of
// the budget and be cancelled with nothing to show for it.
const BROAD_MIN_STAGE_MS = 500;
// Ceiling on a single count probe. The probes only ever feed a total that callers are
// already allowed to read as a lower bound (see totalIsApproximate), so a probe that
// overruns can be abandoned without failing the search — whereas letting it run unbounded
// lets one pathological query hold a connection and saturate disk I/O for the whole
// instance. Measured against production: five concurrent uncached searches took 66-92s
// each and degraded every other endpoint until they drained.
const PROBE_STATEMENT_TIMEOUT_MS = 5000;

export interface ListBooksOptions {
  q?: string;
  /**
   * Which side of the catalogue `q` matches: book titles, or contributor names.
   * Ignored entirely when `q` is absent — a filter-only browse matches nothing
   * textual.
   *
   * When set, the two sides are never searched together. Each is a different
   * query against a different index with its own tier ladder, and the caller is
   * expected to know which one it wants. `GET /api/v2/books` sets it, defaulting
   * to 'title' at the controller.
   *
   * **Undefined means blended**, and that is not the same as 'title'. It selects
   * the pre-v2 path that searches both sides and merges them title-first — the
   * behaviour `GET /api/v1/books` is frozen on, and the only reason
   * fetchBlendedSearchPage and countUnionUpTo still exist. v1 rejects the `type`
   * parameter outright, so no v1 request can reach the single-sided path and no
   * v2 request can reach the blended one.
   */
  searchType?: BookSearchType;
  genre?: string;
  availability?: string;
  productForm?: string;
  publishingStatus?: string;
  publisher?: string;
  /** Exact ISBN-13. Narrower than `q`, and index-backed. */
  isbn?: string;
  /** Inclusive publication-year bounds. */
  yearMin?: number;
  yearMax?: number;
  /**
   * Inclusive price bounds in **GBP pence**, already converted from whatever
   * currency the customer typed. Only meaningful with `shoppable` — the price
   * lives on the Gardners row that flag joins against — and the controller
   * rejects them otherwise rather than returning a silently unfiltered page.
   */
  priceMinGbpPence?: number;
  priceMaxGbpPence?: number;
  /**
   * The currency prices come back in, already resolved by the controller. Also
   * the currency the price bounds were expressed in, so the numbers a client
   * filters by and the numbers it displays are the same.
   */
  currency?: string;
  /** Which field to order by. Ignored whenever `q` is present — relevance wins. */
  sortBy?: 'title' | 'newest';
  sort?: 'asc' | 'desc';
  limit: number;
  offset: number;
  // Opt-in: collapses same-titled editions down to the best one (cover > complete dataset >
  // newest publication date > has a price). See dedupeByTitle in lib/dedupe.ts.
  dedupe?: boolean;
  /**
   * Opt-in: orders the results the way a shop has to — everything Gardners can
   * supply and has on the shelf first, then what is orderable but unstocked,
   * then everything unsellable. See SHOP_BAND for the bands and why there are
   * three of them.
   *
   * This used to *exclude* the unsellable tail rather than sink it, which made
   * `shoppable=true` and `shoppable=false` return different books; they now
   * return the same books in a different order. Callers that relied on the
   * filter should read `shoppable` on each row — the flag says which side of
   * the line a result fell on, so a listing can stop at the boundary itself.
   *
   * `priceMin`/`priceMax` are unaffected and still filter, since a price range
   * is a request for a shelf rather than an ordering. See
   * buildPriceBoundsCondition.
   */
  shoppable?: boolean;
  /**
   * Internal. Set by list()'s band ladder to scope one query to one band; not a
   * request parameter, and never set by a controller. It rides in `opts` rather
   * than being threaded through every fetch signature because the branches that
   * build their own filters — fetchAuthorBranch, rankBroadCandidates — call
   * buildWhereClause(opts) themselves, and would otherwise silently ignore it.
   */
  shopBand?: ShopBand;
  /**
   * For dedupe=true only. When supplied it overrides `offset`: the server
   * resumes at the raw-row position the token encodes and also filters out any
   * titles carried from the previous page's tail, so a title returned on page N
   * cannot be returned again on page N+1.
   */
  cursor?: DedupeCursor | null;
}

/** Opaque token that survives a JSON round-trip via base64url. */
export interface DedupeCursor {
  /** The raw-row offset to resume scanning at. */
  o: number;
  /** Case-folded titles carried from the previous page's tail, to filter here. */
  t: string[];
}

/** How many recent titles to remember in the cursor for cross-page filtering. */
const CURSOR_TAIL_TITLES = 100;

export function encodeDedupeCursor(cursor: DedupeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeDedupeCursor(raw: string | undefined | null): DedupeCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as DedupeCursor).o !== 'number' ||
      !Array.isArray((parsed as DedupeCursor).t)
    ) {
      return null;
    }
    const c = parsed as DedupeCursor;
    if (!Number.isInteger(c.o) || c.o < 0 || c.o > 10_000) return null;
    if (c.t.some((title) => typeof title !== 'string')) return null;
    return { o: c.o, t: c.t.slice(0, CURSOR_TAIL_TITLES) };
  } catch {
    return null;
  }
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

// One row as every list path selects it — LIST_COLUMNS resolved through the query builder,
// taken from a function that actually runs the select so the two cannot drift.
type ListRow = Awaited<ReturnType<typeof fetchTitleSearchPage>>[number];

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
  /**
   * Whether Gardners currently has stock. Only populated on `shoppable=true`
   * requests — optional rather than nullable so the other twenty-odd places
   * that build a BookListItem don't have to invent a value for a field their
   * callers never read. A shoppable result with `inStock: false` is a book the
   * shop should list with an out-of-stock badge, not hide: stock moves hourly,
   * and a title flickering in and out of the catalogue is worse for the user
   * than a title that is visibly, temporarily unavailable.
   */
  inStock?: boolean;
  /**
   * Whether this book is one the shop can actually sell — i.e. it has an
   * ISBN13, a supplier price, and no unsuppliable report code. Present only on
   * `shoppable=true` requests, alongside `inStock`.
   *
   * It exists because `shoppable=true` ranks rather than filters: the unsellable
   * tail is still in the response, at the end, and without this a client would
   * have to infer "unsellable" from a missing price and get it wrong for a book
   * that is merely out of stock. `shoppable: true, inStock: false` is orderable
   * with a longer lead time; `shoppable: false` is not orderable at all and must
   * not be given an Add button.
   */
  shoppable?: boolean;
  /**
   * The live sellable price, in the currency this request resolved to. Present
   * only with `shoppable=true`, alongside `inStock`.
   *
   * This — not the `prices` array — is what the shop charges. That array is
   * ONIX edition metadata and disagrees with the supplier feed on part of the
   * catalogue, so a listing that renders it is showing a price the basket will
   * not honour. It is also what `priceMin`/`priceMax` filter on, so a filtered
   * page can display the number it was filtered by.
   */
  unitPriceMinor?: number;
  /** Pre-markdown price when a promotion is running; null when not on sale. */
  compareAtMinor?: number | null;
  /** ISO-4217 for the two fields above. */
  currency?: string;
}

// Which side of the catalogue a typeahead query is matched against. 'all' (the default)
// matches both and merges the results; the single-sided values exist for callers that
// already know what the user is looking for, such as a dedicated author filter.
export type SuggestionType = 'all' | 'title' | 'author';

// Which side of the catalogue `GET /api/v2/books?q=` matches against. Unlike
// SuggestionType there is no 'all': the two are searched separately and never merged. A
// caller that wants both asks twice and presents the results as two lists, which is the
// honest shape — a blended page has to rank a title match against a name match, and no
// index can supply that ordering (see fetchTitleSearchPage / fetchAuthorSearchPage).
//
// v1 has no equivalent, deliberately: it does not take the parameter at all and always
// blends, so "blended" is the absence of this type rather than a third member of it. A
// third member would let a v2 caller ask for the blended page, which is the thing v2
// exists to stop being the only option.
export type BookSearchType = 'title' | 'author';

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
  /**
   * Live shop fields. Always present on a feed row — every one of these feeds
   * is a shop surface, so there is no unpriced variant of them any more.
   *
   * **Attached after the cache is read, never inside it.** These feeds cache
   * their pool for an hour, and a price is the one thing in this system that
   * must never be served from an hour-old snapshot — supplier prices move
   * hourly, and the whole shop design rests on a displayed price being the price
   * the basket will honour. So the cached payload holds books; the price is put
   * on afterwards, on every request.
   */
  unitPriceMinor?: number;
  compareAtMinor?: number | null;
  currency?: string;
  inStock?: boolean;
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


/**
 * The predicate every discovery feed applies to the books it returns.
 *
 * Two things, both of which the feeds were missing:
 *
 *  - **Withdrawn titles are never surfaced.** `list()` has excluded them since
 *    the browse fix, but trending, personalized and similar each build their
 *    own query and none of them did — so a book Gardners had withdrawn could
 *    still headline the homepage.
 *  - **Unsellable titles are never recommended.** Recommending a book the shop
 *    cannot sell is a dead end wherever it appears — an Add button that 409s, or
 *    a tap-through to a product page with no price and no way to buy. So the
 *    sellable filter (buildShoppableCondition) is unconditional here, *not*
 *    gated on a caller's `shoppable` flag — which the feeds no longer take at
 *    all. Their rows are always sellable and always priced. The flag survives
 *    only on `GET /books`, where it means something different: it *ranks* the
 *    catalogue into shop bands rather than filtering it, because a listing that
 *    changes size with a query parameter cannot be paged through consistently.
 *
 * Exported because the bestseller chart is a feed too, and lives in
 * commerce/bestsellers.service.ts — it ranks off `order_items` rather than off
 * `books`, but it must answer with the same predicate as everything else. A
 * second copy of this over there is exactly the drift this function exists to
 * prevent.
 */
export function buildFeedCondition(): SQL {
  return and(eq(books.isRemoved, false), buildShoppableCondition())!;
}

/**
 * How wide to cast the net before filtering.
 *
 * Roughly a fifth of the catalogue is unsellable, and these feeds fetch a
 * bounded pool then trim — so filtering afterwards can leave a "top 10" holding
 * three. The pool is always widened because the sellable filter now always
 * applies (see buildFeedCondition), on top of the per-viewer exclusion headroom
 * the base pool already carries.
 */
function feedPoolMultiplier(): number {
  return FEED_POOL_MULTIPLIER * 2;
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

// Relevance ordering for the broad tier, parameterised by where the columns live so the
// same expression can rank the books table directly or a materialised candidate pool
// aliased over it. Kept as one function because the two must agree exactly: they decide
// which rows a page contains and in what order, and a divergence between them is a
// reordering bug that only shows up on the fuzzy path.
function buildSearchRankOrderBy(q: string, title: SQL, searchVector: SQL): SQL[] {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  return [
    sql`CASE
      WHEN ${title} ILIKE ${prefix}     THEN 0
      WHEN ${title} ILIKE ${wordPrefix} THEN 1
      WHEN word_similarity(${q}, ${title}) > 0.3 THEN 2
      ELSE 3
    END`,
    sql`word_similarity(${q}, ${title}) DESC`,
    sql`ts_rank(${searchVector}, plainto_tsquery('english', ${q})) DESC`,
  ];
}

function buildSearchOrderBy(q: string): SQL[] {
  return buildSearchRankOrderBy(q, sql`${books.title}`, sql`${books.searchVector}`);
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
// them caps each branch independently: the sort at the end sees at most one cap's worth
// of rows per branch, no matter how popular the name.
//
// The split also puts the prefix tiers where an index can serve them. Tiers 0 and 2 match
// on lower(person_name) LIKE — plain LIKE, not ILIKE, since text_pattern_ops matches no
// other operator — which EXPLAIN confirms is an indexed range scan on
// idx_book_contributors_name_lower_pattern, the same trick buildFastTitlePrefixCondition
// uses on titles. The word-prefix tiers are the trigram GIN's job. Both indexes cover
// every role, so the role predicate is a cheap recheck rather than the thing that decides
// whether an index can be used at all — see db/setup.ts.
//
// Ordering by tier decides which rows survive when the match set exceeds the cap, and in
// what order the page finally reads. Two things are being ranked at once:
//
//   how the name matched — an exact prefix ("chimamanda" → "Chimamanda Ngozi Adichie")
//   beats a word prefix ("adichie" matching mid-name), which beats a fuzzy near-miss;
//
//   how the person is credited — A01 (ONIX's "author") beats every other role.
//
// Match quality is the *outer* key and role the inner one, which is the whole point of
// the ladder. An exact prefix hit on an editor is a far stronger signal than a trigram
// near-miss on an author: someone typing "Catherine Eschle" wants the volume she edited,
// not a fuzzy slide to "Catherine Dawson". Ranking role first would invert that, and
// filtering non-A01 rows out entirely — which is what this did until now — loses the
// edited volume at any spelling. About one book in five has no A01 contributor at all,
// so that was not an edge case.
//
// Tiers 1 and 3 don't repeat their plain-prefix arms — tiers 0 and 2 already cover them,
// and duplicate book ids cost nothing to a caller that takes MIN(tier) per book.
//
// 'broad' adds tier 4, the fuzzy arm (trigram word-similarity + FTS over the name), and is
// only reached when nothing above it matched at all. It is deliberately last and
// deliberately role-blind: by the time it runs, the question is no longer who is credited
// how, but whether any name resembles the query. Callers must run it inside
// withWordSimilarityThreshold, since it uses the <% operator.
export function buildAuthorMatchSource(rawQ: string, tier: 'cheap' | 'broad'): SQL {
  // Both sides of every comparison below are normalised: the column by NAME, the search
  // term here. The prefix tiers compare with LIKE/ILIKE, which are literal, so a name
  // stored as "Catherine  Eschle" is unreachable by "Catherine Eschle" unless the
  // doubled space is collapsed out of the comparison on both sides. See
  // lib/contributor-name.ts. Normalising here rather than at the call sites means a
  // caller cannot forget: the count probe, the row fetch and suggestions all reach the
  // name tiers through this function.
  const q = normaliseNameQuery(rawQ);
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  // Interpolated raw, because it is a column expression rather than a value. It must stay
  // character-identical to the index definition in db/setup.ts — that is the whole reason
  // both come from the same constant.
  const NAME = sql.raw(normalisedNameSql('bc.person_name'));

  // Every branch is capped independently. A single cap on the union would leave each
  // branch to produce its whole match set before the merge could discard it, so cost
  // would scale with how common the name fragment is rather than with the page.
  const exactPrefix = (tierTag: number, role: SQL) => sql`
    (
      SELECT bc.book_id, ${sql.raw(String(tierTag))} AS tier, 1::real AS score
      FROM book_contributors bc
      WHERE ${role}
        AND lower(${NAME}) LIKE lower(${prefix})
      LIMIT ${AUTHOR_MATCH_LIMIT}
    )`;

  const wordPrefixArm = (tierTag: number, role: SQL) => sql`
    (
      SELECT bc.book_id, ${sql.raw(String(tierTag))} AS tier, 1::real AS score
      FROM book_contributors bc
      WHERE ${role}
        AND bc.person_name IS NOT NULL
        AND ${NAME} ILIKE ${wordPrefix}
      LIMIT ${AUTHOR_MATCH_LIMIT}
    )`;

  // <> 'A01' rather than an allow-list of roles. The tier ranking already keeps editors,
  // translators and illustrators below authors, so there is nothing to gain by naming
  // them — and an allow-list would silently drop whichever ONIX role a future feed
  // introduces, which is the failure this change exists to remove.
  const isAuthor = sql`bc.role = 'A01'`;
  const isOtherContributor = sql`bc.role <> 'A01'`;

  const fuzzy =
    tier === 'broad'
      ? sql`
    UNION ALL
    (
      SELECT bc.book_id, 4 AS tier, word_similarity(${q}, ${NAME}) AS score
      FROM book_contributors bc
      WHERE bc.person_name IS NOT NULL
        AND (
          ${q} <% ${NAME}
          ${
            q.length >= 3
              ? sql` OR to_tsvector('simple', ${NAME}) @@ plainto_tsquery('simple', ${q})`
              : sql``
          }
        )
      LIMIT ${AUTHOR_MATCH_LIMIT}
    )`
      : sql``;

  return sql`(
    ${exactPrefix(0, isAuthor)}
    UNION ALL
    ${wordPrefixArm(1, isAuthor)}
    UNION ALL
    ${exactPrefix(2, isOtherContributor)}
    UNION ALL
    ${wordPrefixArm(3, isOtherContributor)}
    ${fuzzy}
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

/** A matched book's best name-match tier, and how well the name actually scored. */
type AuthorMatchRank = { tier: number; score: number };

// Book ids whose name matched, mapped to their best (lowest) tier and best score.
//
// Score is what separates rows *within* a tier, and it only carries information in the
// fuzzy tier — the exact tiers are all equally exact and report a flat 1. Without it every
// fuzzy match ties and the sort falls through to title order, so a name that scored a
// perfect 1.0 lands wherever the alphabet puts it: measured, "Christine McLaughlin"
// matched her book at word_similarity 1.0 and still sat past position 50, behind "100
// Buttercream Flowers" and "4.50 from Paddington". Tier decides the band, score orders
// within it.
//
// The ORDER BY has to be total, and has to be the same order the caller finally displays
// in — not just "tier first". `take` grows with the requested page, so page 2 asks for a
// larger sample than page 1; unless the ordering is deterministic and page-independent,
// the two samples are different arbitrary subsets of the tied rows and pages overlap. That
// is not hypothetical: with a bare ORDER BY MIN(tier), a prolific author's page 2 repeated
// a book from page 1, because 171 rows tied at tier 0 and Postgres was free to return any
// 30 of them. Ordering by (tier, score, title, id) makes every sample a prefix of the next
// one — id last, because it is the only column guaranteed to break every remaining tie.
async function rankAuthorMatches(
  conn: Pick<typeof db, 'execute'>,
  q: string,
  tier: 'cheap' | 'broad',
  take: number,
): Promise<Map<number, AuthorMatchRank>> {
  const ranked = await conn.execute<{ id: number; tier: number; score: number }>(sql`
    SELECT m.book_id AS id, MIN(m.tier) AS tier, MAX(m.score) AS score
    FROM ${buildAuthorMatchSource(q, tier)} m
    JOIN ${books} ON ${books.id} = m.book_id
    GROUP BY m.book_id, ${books.title}
    ORDER BY MIN(m.tier), MAX(m.score) DESC, lower(${books.title}), m.book_id
    LIMIT ${take}
  `);

  const rankById = new Map<number, AuthorMatchRank>();
  for (const row of ranked as unknown as { id: number; tier: number; score: number }[]) {
    rankById.set(Number(row.id), { tier: Number(row.tier), score: Number(row.score) });
  }
  return rankById;
}

// Exact-prefix names first, then by how well the name scored, then alphabetically. Must
// be the same total order rankAuthorMatches applies in SQL, including the id tiebreak —
// the ranking decides *which* rows a page can contain and this decides where they sit, so
// a disagreement between them puts a row on two pages or on none. Every key here has a
// counterpart in that ORDER BY, in the same sequence and the same direction.
function byAuthorTierThenTitle<T extends { id: number; title: string }>(
  rankById: Map<number, AuthorMatchRank>,
) {
  return (a: T, b: T) => {
    const [ra, rb] = [rankById.get(a.id)!, rankById.get(b.id)!];
    if (ra.tier !== rb.tier) return ra.tier - rb.tier;
    // Descending: a better score sorts earlier, matching MAX(m.score) DESC.
    if (ra.score !== rb.score) return rb.score - ra.score;
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
  // id last, for the same reason rankAuthorMatches carries one: without a total order,
  // tied titles are returned in whatever order Postgres finds convenient, and since each
  // page fetches a larger LIMIT than the last, two pages get different arbitrary subsets
  // of the tie and overlap. Duplicate and near-duplicate titles are common here (editions
  // of one book share a title exactly), so the ties are not rare.
  return [sql`CASE WHEN ${books.title} ILIKE ${prefix} THEN 0 ELSE 1 END`, asc(books.title), asc(books.id)];
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
  // See buildTitlePrefixOrderBy for why the id is here. It costs this tier its index-only
  // sort — lower(title) alone can be walked straight off idx_books_title_lower_pattern —
  // but the tier's match set is already bounded by the page, so the extra sort is over
  // tens of rows, and measured it does not move the timings.
  return [sql`lower(${books.title})`, asc(books.id)];
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
/**
 * Ordering for a browse (no `q`). Backwards compatible by construction: with
 * neither sortBy nor sort supplied this is `updatedAt`, exactly as before, and
 * a bare `sort` still means title — the meaning it had when it was the only
 * ordering knob there was.
 *
 * `newest` orders on publication_date, which is nullable; undated books sort
 * last in both directions rather than crowding the top of a "newest" page,
 * where Postgres would otherwise put them descending.
 *
 * There is deliberately no `price` here. Price lives on the correlated Gardners
 * row, so ordering by it means evaluating that subquery for every candidate row
 * *before* the LIMIT applies — the same shape as the title-sort regression
 * documented on buildFastTitlePrefixOrderBy, and unmeasured against the real
 * table. It needs an EXPLAIN against production data before it exists.
 */
/**
 * Converts a live GBP price into the currency the request resolved to.
 *
 * Returns nothing at all when the book has no live price — which should not
 * happen for a row that cleared buildShoppableCondition, but a missing key is a
 * better answer than a zero that reads as "free".
 */
function priceFields(
  live: { unitPriceGbpPence: number; compareAtGbpPence: number | null } | undefined,
  currency: string | undefined,
): { unitPriceMinor: number; compareAtMinor: number | null; currency: string } | Record<string, never> {
  if (!live) return {};
  const code = (currency ?? config.commerce.currency.default).toUpperCase();
  return {
    unitPriceMinor: toPresentment(live.unitPriceGbpPence, code),
    compareAtMinor:
      live.compareAtGbpPence === null ? null : toPresentment(live.compareAtGbpPence, code),
    currency: code,
  };
}

/**
 * Sinks placeholder titles to the bottom of a title-ordered page.
 *
 * The catalogue carries rows whose title is punctuation and nothing else — `?`,
 * `.`, `...`, `-`, the odd empty string — which sort ahead of every real book in
 * ASCII order and so occupied the first page of `sortBy=title&sort=asc`. This is
 * the rank they sort on first: 0 for a real title, 1 for one with no letter or
 * digit anywhere in it.
 *
 * "No alphanumeric character *anywhere*" rather than the simpler "first
 * character isn't alphanumeric", which would bury real books: quoted titles
 * (`"The Nose"`) are common enough to appear four times in a 1000-row sample of
 * the live catalogue, and `#Girlboss`-style titles are the same shape.
 *
 * NULL titles rank 1 too — `NULL ~ '...'` is NULL, so the CASE falls through to
 * its ELSE — which is the intended answer, and saves a separate NULLS LAST.
 */
const TITLE_JUNK_RANK = sql`(CASE WHEN ${books.title} ~ '[[:alnum:]]' THEN 0 ELSE 1 END)`;

export function buildSortOrderBy(opts: ListBooksOptions): (SQL | PgColumn)[] {
  // The rank is always ASC, including when the title is DESC: "at the bottom"
  // is a statement about the page, not about the sort direction, so reversing
  // the title must not float the placeholders to the top. That asymmetry is
  // also why it takes two indexes rather than one read backwards — see
  // 0056_books_title_sortable_index.sql.
  const byTitle = (): SQL[] => [TITLE_JUNK_RANK, sql`${books.title} ${opts.sort === 'desc' ? sql`DESC` : sql`ASC`}`];

  switch (opts.sortBy) {
    case 'title':
      return byTitle();
    case 'newest':
      return [
        sql`${books.publicationDate} ${opts.sort === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`,
      ];
    default:
      return opts.sort ? byTitle() : [books.updatedAt];
  }
}

function buildWhereClause(opts: ListBooksOptions, searchCondition?: SQL): SQL | undefined {
  const conditions: SQL[] = [];

  // Titles Gardners has withdrawn (ONIX notification '05') are never browsable.
  // The row survives the withdrawal on purpose — it still anchors a user's
  // posts, reviews and reading-list entries, see books.isRemoved — but it must
  // not appear in a catalogue listing. listByIds() already filtered this and
  // list() did not, so withdrawn books were reachable through browse and
  // search while being 404-shaped everywhere else.
  //
  // Applied here rather than at each call site so it covers every list path at
  // once: the title branch, the author branch (fetchAuthorBranch), all three
  // search tiers, and the count probes that must agree with them.
  conditions.push(eq(books.isRemoved, false));

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

  if (opts.isbn) {
    conditions.push(eq(books.isbn13, opts.isbn));
  }

  // Half-open in neither direction: a buyer who asks for 1990-2000 means both
  // endpoints. Books with no publication date drop out of a year-filtered
  // result, which is correct — an undated book cannot be shown to satisfy a
  // date range.
  if (opts.yearMin !== undefined) {
    conditions.push(sql`${books.publicationDate} >= ${`${opts.yearMin}-01-01`}`);
  }

  if (opts.yearMax !== undefined) {
    conditions.push(sql`${books.publicationDate} <= ${`${opts.yearMax}-12-31`}`);
  }

  // `shoppable` itself is no longer a condition — it orders, and list() walks
  // the bands. What survives here is the half of it that was always a genuine
  // filter: an explicit price range. It is applied on any `shoppable=true`
  // request, band or no band, so every band's query agrees on which shelf it is
  // paginating over.
  if (opts.shoppable) {
    const priceBounds = buildPriceBoundsCondition({
      minGbpPence: opts.priceMinGbpPence,
      maxGbpPence: opts.priceMaxGbpPence,
    });
    if (priceBounds) conditions.push(priceBounds);
  }

  if (opts.shopBand !== undefined) {
    conditions.push(buildShopBandCondition(opts.shopBand));
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

// Postgres reports a statement_timeout abort as query_canceled. Narrowed deliberately:
// every other failure is a real bug and must keep propagating.
function isStatementTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '57014';
}

// SET LOCAL scopes the timeout to the wrapped statement inside a transaction — a bare SET
// would stick to the pooled connection and silently apply to unrelated queries that reuse
// it afterwards. Same rationale as withWordSimilarityThreshold above.
async function withStatementTimeout<T>(
  ms: number,
  fn: (conn: Pick<typeof db, 'select' | 'execute'>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(ms))}`));
    return fn(tx);
  });
}

// The fuzzy tier needs both GUCs, and needs them in a transaction of its own rather than
// one shared with the author branch. A statement_timeout abort poisons its whole
// transaction: sharing one would mean a cancelled title stage also killing the author
// query that had already succeeded beside it. Separate transactions also let the two
// branches run concurrently again, which the shared-transaction arrangement gave up.
async function withBroadTierSession<T>(
  timeoutMs: number,
  fn: (conn: Pick<typeof db, 'select' | 'execute'>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw('SET LOCAL pg_trgm.word_similarity_threshold = 0.3'));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`));
    return fn(tx);
  });
}

// Counts the union of two conditions, each bounded independently. Used only by v1's
// blended total, which has to count books matched by either side; a v2 search counts the
// one side it asked for with a plain countUpTo.
//
// The obvious shape — one scan with the conditions OR'd together — is a trap. Postgres
// cannot estimate the cardinality of the author subquery, so `id IN (...)` falls back to
// the default 0.5 selectivity: on the production catalogue it estimated 994,218 rows
// against 1,988,039 actual, i.e. exactly reltuples/2. An OR across a trigram-indexable
// predicate and a subquery membership test cannot be served by a BitmapOr in any case, so
// the planner chose a Seq Scan and evaluated the hashed SubPlan once per row. The LIMIT
// could only cut that short for terms common enough to hit the cap early, which inverted
// the cost profile: "harry" stopped after ~560k rows (2.5s), while a selective term like
// "bookkeeping" (51 matches) had to scan all 1.98M rows to prove there were no more —
// 9.5s and 1.42GB of disk reads for one probe.
//
// Splitting the branches keeps each on its own index and lets UNION dedupe the ids.
// Verified on production to return identical counts (51, 0, 24 for bookkeeping,
// zephyrbook, chimamanda) at 15-30x less cost.
//
// Each branch carries its own cap, so this can reach 2*cap where the OR'd form stopped at
// cap. Both are far above SEARCH_COUNT_CAP, which every caller clamps the total to, so the
// reported figure is unchanged.
//
// Even in its split form this is the most expensive probe a v1 search issues, and it runs
// on every uncached one. That cost is the price of v1's blended page and the reason v2
// exists; it is not a defect to be optimised away here.
async function countUnionUpTo(
  whereA: SQL | undefined,
  whereB: SQL | undefined,
  cap: number,
): Promise<number> {
  return withStatementTimeout(PROBE_STATEMENT_TIMEOUT_MS, async (conn) => {
    const rows = await conn.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM (
            (SELECT ${books.id} FROM ${books} WHERE ${whereA ?? sql`TRUE`} LIMIT ${cap})
            UNION
            (SELECT ${books.id} FROM ${books} WHERE ${whereB ?? sql`TRUE`} LIMIT ${cap})
          ) t`,
    );
    return Number((rows as unknown as { count: number }[])[0]?.count ?? 0);
  });
}

// Fetches one page of search results from exactly one side of the catalogue — titles or
// contributor names, never both. This is the v2 path; v1 still merges the two, in
// fetchBlendedSearchPage below.
//
// The split was always there physically even when v1's API hid it, and that is why the
// merge costs what it does — the title branch's speed comes entirely from its ORDER BY
// matching an index's own ordering (see buildFastTitlePrefixOrderBy), and no single index
// can order a title match against a name match, so a blended query made Postgres sort the
// whole candidate set: ~322k rows for a prefix like "the". Splitting the branches and
// merging in memory is what v1 does instead; naming the side, as v2 does, removes the
// second branch and the merge together.
//
// Each side keeps its own tier ladder, because they escalate on different evidence:
//   - titles: fast prefix → cheap word-prefix → broad (trigram/FTS over a bounded pool)
//   - names:  cheap name-prefix → broad (trigram/FTS over book_contributors)
// They are deliberately not escalated in lockstep. "peace adzo medie" matches no title
// prefix at all but is an exact prefix of a person_name, which the cheap name tier answers
// from its index in microseconds — under the old lockstep escalation that query went
// straight to the fuzzy name scan, exceeded its time budget, was cancelled, and returned
// nothing. Now it is simply an author search, and never touches the title ladder.

// Ranks the broad tier against a bounded pool instead of the whole fuzzy match set.
//
// The inner LIMIT is the whole point and has to stay inside the subquery: it caps the rows
// the ranking is evaluated over. Hoisting it to the outer query would restore exactly the
// shape this replaces, where LIMIT applies to the output and the sort still has to consider
// every match first.
//
// The pool is ordered by id, and that ordering is load-bearing rather than cosmetic. An
// unordered LIMIT is cheaper but resamples: measured against production, two identical
// "thhe" searches returned different pools, which would put a book on two pages or on none
// as the offset advanced — the same hazard rankAuthorMatches documents. Ordering by id is
// the cheapest total order available, because books_pkey can be walked in order and the
// scan stops as soon as the pool is full. It costs roughly 800ms on the densest terms
// (thhe 731ms unordered vs 1525ms ordered) and is *faster* on sparse ones, against a
// baseline of 100s.
//
// It does bias the pool toward lower ids, i.e. earlier-ingested books. That is arbitrary,
// but so is every alternative here: 166,111 titles tie at word_similarity 0.5 for "thhe",
// so no selection among them is more correct than another. Deterministic-arbitrary beats
// random-arbitrary, because it paginates and caches correctly.
//
// The ranking is then a total order through title and id. The unpooled form it replaces
// had no tiebreak at all, and with ties that large it was genuinely unstable: two
// identical production searches 100s apart returned different pages (18/21 overlap, a
// different top result).
async function rankBroadPool(
  conn: Pick<typeof db, 'execute'>,
  opts: ListBooksOptions,
  q: string,
  take: number,
  pool: number,
): Promise<number[]> {
  const where = buildWhereClause(opts, buildSearchCondition(q));
  const ranking = buildSearchRankOrderBy(q, sql`c.title`, sql`c.search_vector`);
  const ranked = await conn.execute<{ id: number }>(sql`
    SELECT c.id
    FROM (
      SELECT ${books.id} AS id, ${books.title} AS title, ${books.searchVector} AS search_vector
      FROM ${books}
      WHERE ${where ?? sql`TRUE`}
      ORDER BY ${books.id}
      LIMIT ${pool}
    ) c
    ORDER BY ${sql.join(ranking, sql`, `)}, lower(c.title), c.id
    LIMIT ${take}
  `);
  return (ranked as unknown as { id: number }[]).map((r) => Number(r.id));
}

// Widens the candidate pool for as long as the time budget allows, returning the best
// ranking that actually completed.
//
// Each stage is a separate attempt against a wider pool, given whatever remains of the
// budget as its statement_timeout. A stage that overruns is cancelled and its transaction
// discarded, leaving the previous stage's result — already in hand — as the answer. So the
// page is always ranked from the widest pool that fitted in BROAD_TIME_BUDGET_MS, and the
// tier cannot exceed it regardless of how dense the fuzzy neighbourhood turns out to be.
//
// A wider pool is a strict improvement on a narrower one, never a different kind of answer:
// same filter, same ordering, more candidates considered. Falling back to a narrow stage
// costs relevance, not correctness.
async function rankBroadCandidates(
  opts: ListBooksOptions,
  q: string,
  take: number,
): Promise<number[]> {
  const deadline = Date.now() + BROAD_TIME_BUDGET_MS;
  let best: number[] = [];

  for (const pool of BROAD_POOL_STAGES) {
    const remaining = deadline - Date.now();
    if (remaining < BROAD_MIN_STAGE_MS) break;
    try {
      best = await withBroadTierSession(remaining, (conn) => rankBroadPool(conn, opts, q, take, pool));
    } catch (err) {
      if (!isStatementTimeout(err)) throw err;
      logger.warn('Fuzzy search tier hit its time budget — ranking from a narrower pool', {
        q,
        pool,
        budgetMs: BROAD_TIME_BUDGET_MS,
      });
      break;
    }
  }
  return best;
}

// The pool query already applied every filter (it shares buildWhereClause with the
// unpooled form), so the ids coming back need only be resolved to rows — unlike the author
// branch, whose ranking runs over book_contributors and cannot filter books.
async function fetchBroadTitleBranch(opts: ListBooksOptions, q: string, branchLimit: number) {
  const ids = await rankBroadCandidates(opts, q, branchLimit);
  if (ids.length === 0) return [];

  // Resolving ids to rows needs neither GUC and is a plain indexed lookup, so it runs
  // outside the budgeted stages rather than eating into them.
  const rows = await db.select(LIST_COLUMNS).from(books).where(inArray(books.id, ids));
  // Relevance order lives in the id list; the fetch above discards it.
  const rank = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return rows;
}

async function fetchTitleSearchPage(
  opts: ListBooksOptions,
  q: string,
  tier: 'fast' | 'cheap' | 'broad',
  titleWhere: SQL | undefined,
  // Ranking for the fast and cheap tiers, both of which sort an already-narrow index-backed
  // match set. The broad tier ignores it and ranks inside its own bounded pool instead —
  // see rankBroadCandidates for why it cannot simply sort what it matches.
  titleOrderBy: (SQL | PgColumn)[],
  // The page size to fetch — opts.limit normally, or opts.limit + DEDUPE_POOL_HEADROOM
  // when the caller is about to dedupe the result.
  pageSize: number,
) {
  const branchLimit = opts.offset + pageSize + 1;

  if (tier === 'broad') {
    // The pool query applies every filter itself, so this returns rows already ranked.
    const rows = await fetchBroadTitleBranch(opts, q, branchLimit);
    return rows.slice(opts.offset, branchLimit);
  }

  // Offset is pushed into SQL rather than sliced off in memory: with no merge, the offset
  // applies directly to this branch's own ordering. The index-ordered plan is what makes
  // the fast tier fast, and it survives an OFFSET untouched.
  return db
    .select(LIST_COLUMNS)
    .from(books)
    .where(titleWhere)
    .orderBy(...titleOrderBy)
    .limit(pageSize + 1)
    .offset(opts.offset);
}

// The name side. Its ladder is cheap-first and escalates only on an empty result: an
// index-backed name-prefix hit is both the fastest answer available and a better one than
// anything the fuzzy tier could produce, so it settles the search outright. Only a query
// that matched no name at all is worth paying the fuzzy scan for.
//
// Losing the escalation to a timeout costs the fuzzy rows, not the request — an author
// search that overruns its budget answers empty rather than 500ing.
async function fetchAuthorSearchPage(opts: ListBooksOptions, q: string, pageSize: number) {
  const branchLimit = opts.offset + pageSize + 1;

  const cheapRows = await fetchAuthorBranch(db, opts, q, 'cheap', branchLimit);
  if (cheapRows.length > 0) return cheapRows.slice(opts.offset, branchLimit);

  const broadRows = await withBroadTierSession(BROAD_TIME_BUDGET_MS, (conn) =>
    fetchAuthorBranch(conn, opts, q, 'broad', branchLimit),
  ).catch((err: unknown) => {
    if (!isStatementTimeout(err)) throw err;
    logger.warn('Fuzzy author search hit its time budget — returning no name matches', { q });
    return [] as Awaited<ReturnType<typeof fetchAuthorBranch>>;
  });

  // Sliced rather than offset in SQL: the ranking lives in rankAuthorMatches' id ordering,
  // which the row fetch discards and re-applies in memory (see byAuthorTierThenTitle).
  return broadRows.slice(opts.offset, branchLimit);
}

// The v1 path: one page of search results as two independently-bounded branches — books
// matched by title, then books matched by their author's name — merged title-first.
//
// This is frozen behaviour. `GET /api/v1/books` has no `type` parameter and always lands
// here; every criticism of the shape below is answered by v2 rather than by changing it,
// because changing it is what broke clients the first time. Read fetchTitleSearchPage and
// fetchAuthorSearchPage for the version that does not have to make these compromises.
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
// before this distinction existed, with the author's own books below the fold. The rule is
// tuned rather than principled — there is no common scale on which a title match and a
// name match can be ranked — which is the argument v2 makes by refusing to blend at all.
//
// Within a branch, no cross-branch relevance score is attempted: none of the indexes
// involved can supply one, and computing it would mean ranking the merged set in SQL,
// which is what makes the single-query version slow.
//
// The branches fetch from row 0 rather than pushing `offset` into SQL, since the offset
// applies to the merged sequence, not to either branch — so a deep page transfers
// offset+limit rows per branch. That is bounded by the max page size (50) and by
// SEARCH_COUNT_CAP making pagination past ~1000 rows meaningless for a search anyway.
// (fetchTitleSearchPage can push the offset down into SQL precisely because it has no
// merge to apply it to.)
async function fetchBlendedSearchPage(
  opts: ListBooksOptions,
  q: string,
  tier: 'fast' | 'cheap' | 'broad',
  titleWhere: SQL | undefined,
  // Ranking for the fast and cheap tiers, both of which sort an already-narrow index-backed
  // match set. The broad tier ignores it and ranks inside its own bounded pool instead —
  // see rankBroadCandidates for why it cannot simply sort what it matches.
  titleOrderBy: (SQL | PgColumn)[],
  // The page size to fetch per branch — opts.limit normally, or opts.limit +
  // DEDUPE_POOL_HEADROOM when the caller is about to dedupe the merged result.
  pageSize: number,
  // Whether the exact band — cheap title OR cheap name, in any contributor role — has
  // rows at this offset. Only consulted on the broad tier, where it is the difference
  // between "nothing matched exactly, go fuzzy" and "a name matched exactly, and the
  // fuzzy pool has nothing to add above it". See the broad branch below.
  exactBandSatisfied = false,
) {
  const branchLimit = opts.offset + pageSize + 1;

  const titleQuery = (conn: Pick<typeof db, 'select'>) =>
    conn.select(LIST_COLUMNS).from(books).where(titleWhere).orderBy(...titleOrderBy).limit(branchLimit);

  // The author branch keeps the expensive trigram/FTS path off every ordinary search by
  // trying its cheap tier first, regardless of which tier the *title* branch landed on.
  //
  // These two used to be escalated together: a broad title tier forced a broad author
  // tier. That is wrong, because the tiers measure different things. "peace adzo medie"
  // matches no title prefix, so the title branch falls to broad — but it is an exact
  // prefix of a person_name, which the cheap tier answers from the name index in
  // microseconds. Escalating in lockstep sent that query straight to the fuzzy name scan
  // over the whole contributor table, which on the production catalogue exceeded
  // BROAD_TIME_BUDGET_MS, was cancelled, and returned nothing — so the one genuinely
  // correct result was dropped and the page came back as title near-misses only.
  //
  // Cheap-first is what suggestions() has always done (see authorSuggestionsFor), and the
  // blended count probe already counts with the cheap tier — which is why the reported
  // total could include a book the rows themselves had lost.
  const authorQuery = (conn: Pick<typeof db, 'select' | 'execute'>, authorTier: 'cheap' | 'broad' = 'cheap') =>
    fetchAuthorBranch(conn, opts, q, authorTier, branchLimit);

  let titleRows: Awaited<ReturnType<typeof titleQuery>>;
  let authorRows: Awaited<ReturnType<typeof authorQuery>>;
  if (tier === 'broad') {
    // Each branch scopes its own GUCs, so they run concurrently and a title stage
    // cancelled by the time budget cannot take the author query down with it.
    //
    // Within the author branch, cheap comes first: an index-backed name-prefix hit is both
    // the fastest answer available and a better one than anything the fuzzy tier could
    // produce, so it settles the branch outright. Only a query that matched no name at all
    // is worth paying the fuzzy scan for, and that escalation keeps the budget it always
    // had — "an ambiguous search answers within the budget" has to hold for the whole
    // tier, not just the branch that was measured to be expensive. Losing the escalation
    // to a timeout costs the author-matched rows, not the page.
    const authorBranch = async (): Promise<Awaited<ReturnType<typeof authorQuery>>> => {
      const cheapRows = await authorQuery(db, 'cheap');
      if (cheapRows.length > 0) return cheapRows;
      return withBroadTierSession(BROAD_TIME_BUDGET_MS, (conn) => authorQuery(conn, 'broad')).catch(
        (err: unknown) => {
          if (!isStatementTimeout(err)) throw err;
          logger.warn('Author branch of the fuzzy tier hit its time budget — omitting it', { q });
          return [] as Awaited<ReturnType<typeof authorQuery>>;
        },
      );
    };

    if (exactBandSatisfied) {
      // Reaching the broad tier means no title matched a prefix at this offset — so if
      // the exact band still has rows, they are name matches, and every one of them
      // outranks anything the fuzzy pool could produce. Running it anyway would spend
      // the most expensive query in the search (a word_similarity ranking over a bounded
      // pool, the multi-second part on the full catalogue) purely to pad the page out
      // below results that are already correct.
      //
      // This is the "if that's not there" in the ladder doing real work: fuzzy matching
      // of any kind is reserved for queries that matched nothing exactly, anywhere.
      titleRows = [];
      authorRows = await authorQuery(db, 'cheap');
    } else {
      [titleRows, authorRows] = await Promise.all([
        fetchBroadTitleBranch(opts, q, branchLimit),
        authorBranch(),
      ]);
    }
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
  ): Promise<{
    books: BookListItem[];
    total: number;
    hasMore: boolean;
    totalIsApproximate: boolean;
    /**
     * Opaque token to pass back as `?cursor=` for the next page.
     *
     * Only meaningful when `dedupe=true` — offset pagination on the dedupe
     * path can return the same title on consecutive pages, since two raw
     * editions of the same book can sit either side of a page boundary.
     * The cursor stops that by carrying a small tail of already-returned
     * titles into the next request as a hard filter, plus the raw offset
     * to resume at. Null when dedupe is off or no more pages remain.
     */
    nextCursor: string | null;
  }> {
    // v2: the cached row payload changed shape (now { rows, hasMore }) and the cached
    // count is now capped for searches — bumping the prefix retires incompatible entries
    // rather than letting them deserialize into the wrong shape.
    // v3: searches now match on author name too, so the same key yields a different (and
    // larger) result set than anything cached under v2.
    // v4: opts now includes `dedupe`, which changes both which rows come back and how many
    // — every request now hashes it (even dedupe:false, since the schema always supplies a
    // default), so bumping avoids a generation of guaranteed-stale v3 lookups post-deploy.
    // v5: withdrawn titles (is_removed) are filtered out of every list path now, so a v4
    // entry can hold rows and totals that include books this endpoint must no longer
    // return. Bumping retires them instead of serving them until their TTL lapses.
    // v6: `q` no longer matches titles and author names together on every path — opts now
    // carries `searchType`, and a v5 entry for the same query holds the old blended page.
    // v7: `shoppable=true` ranks instead of filtering. A v6 entry for a shoppable request
    // holds a page with the unsellable books removed and no `shoppable` field on any row —
    // both the wrong rows and the wrong shape, and a client reading the new field off a
    // cached page would find it missing and treat every book as unsellable.
    //
    // Deliberately not bumped again for v1/v2 coexistence. The two versions share this
    // function and this key space, and they stay separated by the hash itself: v2 always
    // supplies `searchType`, v1 never does, and JSON.stringify omits an absent key
    // entirely, so a blended entry and a title entry for the same query hash differently.
    // A bump would buy nothing and cost a cold start on a 1.9M-row catalogue whose
    // uncached searches are the expensive case this cache exists for. The invariant that
    // makes this safe is enforced at the controllers: v1 rejects `type` with a 400 and
    // never sets `searchType`; v2 always defaults it to 'title'. If either ever passed
    // `searchType: undefined` explicitly it would still hash as absent, which is the
    // blended page — hence v2's controller defaulting rather than forwarding an optional.
    const rowsCacheKey = `books:list:v7:${createHash('sha256').update(JSON.stringify(opts)).digest('hex')}`;
    // Keyed only on the fields that affect the count (not limit/offset/sort) so every
    // page of the same filter — and every sort direction — shares one cached total.
    //
    // Derived by *removing* the page-shape fields rather than by listing the filters,
    // because the enumerated version was a silent-wrong-answer waiting to happen: a new
    // filter added to ListBooksOptions and to buildWhereClause but forgotten here would
    // hash to the same key as the unfiltered request, and every filtered page would report
    // the whole catalogue's total. Rest-destructuring means a new filter is counted
    // correctly the moment it exists, and only a genuinely page-shaped field has to be
    // added to this list.
    const {
      sort: _sort,
      sortBy: _sortBy,
      limit: _limit,
      offset: _offset,
      dedupe: _dedupe,
      cursor: _cursor,
      ...countFilters
    } = opts;
    // v5: see the v6 note on the rows key — a blended total is wrong for either single
    // side, and `searchType` rides in countFilters via the rest-destructure above, which
    // is also what keeps v1's and v2's totals in separate entries.
    // v6: a shoppable total now counts the whole filtered catalogue rather than the
    // sellable slice of it, because nothing is excluded any more. A v5 entry would report
    // the old, smaller number against a listing that runs well past it — and the band
    // ladder pages by offset, so a total that stops short strands the tail.
    const countCacheKey = `books:count:v6:${createHash('sha256')
      .update(JSON.stringify(countFilters))
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
    // are choosing between. An author search never runs them: its ladder escalates on
    // whether any name matched, which the branch itself already knows, so there is nothing
    // for a probe to decide.
    //
    // A blended (v1) search runs a third probe on top of the title ones. It has to count
    // books matched by *either* side, and a title probe alone would undercount a search
    // like "chimamanda" to zero. It is the expensive one — see countUnionUpTo — and it is
    // the cost a v2 caller stops paying, since each single side counts itself.
    const isAuthorSearch = opts.searchType === 'author';
    const isBlendedSearch = opts.searchType === undefined;
    let fastCount = 0;
    let cheapCount = 0;
    let blendedCount = 0;
    // Set when a count probe gave up, so the total it feeds is known to be a lower bound
    // rather than a real count — see the total handling further down.
    let countProbeIncomplete = false;
    // The probes answer two separate questions, and a request rarely needs both. The title
    // probes pick the row tier, so they are only needed when the rows have to be fetched;
    // a count probe feeds nothing but the total, so it is only needed when the total is
    // not already cached.
    const needsTier = !cachedRows;
    const needsCount = cachedCount == null;
    if (opts.q && isAuthorSearch) {
      // One probe, and only for the caption. The name match set is bounded by
      // buildAuthorMatchCondition's own LIMIT, so this is cheap by construction — but it
      // is still the fuzzy tier's neighbour, so a timeout degrades the total rather than
      // failing the search.
      if (needsCount) {
        cheapCount = await countUpTo(
          buildWhereClause(opts, buildAuthorMatchCondition(opts.q, 'cheap')),
          SEARCH_COUNT_CAP + 1,
        ).catch((err: unknown) => {
          if (!isStatementTimeout(err)) throw err;
          logger.warn('Author search count probe timed out — reporting a lower bound', {
            q: opts.q,
          });
          countProbeIncomplete = true;
          return 0;
        });
      }
    } else if (opts.q && (needsTier || needsCount)) {
      const q = opts.q;
      fastCount = await countUpTo(
        buildWhereClause(opts, buildFastTitlePrefixCondition(q)),
        SEARCH_COUNT_CAP + 1,
      );
      // Once the fast tier alone has hit the cap, neither wider probe can change any answer
      // this function produces: rowsTier below already resolves to 'fast', and the reported
      // total is Math.min(_, SEARCH_COUNT_CAP), which fastCount has itself already exceeded.
      if (fastCount <= SEARCH_COUNT_CAP) {
        const [cheap, blended] = await Promise.all([
          countUpTo(buildWhereClause(opts, buildTitlePrefixCondition(q)), SEARCH_COUNT_CAP + 1),
          // Only v1 needs this, and only when the total is not already cached. Running it
          // whenever *either* probe set was missing meant paginating re-ran the expensive
          // one on every new offset despite the count being cached under a page-independent
          // key for COUNT_TTL — 3.5s for "harry&offset=20" and 11.5s for
          // "bookkeeping&offset=20", entirely to recompute a number already in Redis.
          !isBlendedSearch || !needsCount
            ? Promise.resolve(0)
            : countUnionUpTo(
                buildWhereClause(opts, buildTitlePrefixCondition(q)),
                buildWhereClause(opts, buildAuthorMatchCondition(q, 'cheap')),
                SEARCH_COUNT_CAP + 1,
              ).catch((err: unknown) => {
                if (!isStatementTimeout(err)) throw err;
                // The total is the only thing this probe feeds, and callers already read it
                // as a lower bound. Degrading to the title-only counts keeps the search
                // answerable instead of failing the whole request on a caption.
                logger.warn('Blended search count probe timed out — reporting a lower bound', {
                  q,
                });
                countProbeIncomplete = true;
                return 0;
              }),
        ]);
        cheapCount = cheap;
        blendedCount = blended;
      }
    }
    // blendedCount already counts the union of both branches, so it dominates the title-only
    // probes — max() rather than a sum, which would double-count books matching both. It is
    // 0 for a v2 search, which never runs that probe.
    const searchMatchCount = Math.max(fastCount, cheapCount, blendedCount);

    // Size of the exact band: everything the cheap tiers match — on the side being searched
    // for v2, or by title or name in any contributor role for v1's blended page.
    // The cached total is folded in because it *is* this number — it is only ever derived
    // from cheap-tier probes, never from the fuzzy tier — and a paginating request that
    // finds the count already cached does not recompute it. Without this, page 2 of an
    // exact-name search would see a count of 0, conclude the exact band was empty, and drop
    // to the fuzzy tier that page 1 correctly skipped: the same query answered two
    // different ways on two pages.
    const exactBandCount = Math.max(
      searchMatchCount,
      cachedCount != null ? parseInt(cachedCount, 10) : 0,
    );

    type SearchTier = 'fast' | 'cheap' | 'broad';
    const pageEnd = opts.offset + opts.limit;
    // The broad tier is now reserved for searches the cheaper tiers can't answer *at all*
    // at this offset (in practice: typos and pure fuzzy matches). Previously any query
    // whose prefix matches couldn't fill a whole page fell through to it — which is why a
    // specific multi-word title like "the god of small things" (a handful of real
    // editions, nowhere near a 20-row page) hit the slowest path and timed out. Returning
    // that handful of genuine matches is both far faster and better ranked than padding
    // the page out with fuzzy near-misses.
    //
    // The cheap tier is held while the *exact band* still has rows at this offset, not
    // merely while the title count does, so the ladder cannot abandon a tier with supply
    // left to give. The two are different numbers on v1's blended page, where the probes
    // measure titles only but the tier's output is titles merged with name matches.
    // Measured on "roald dahl": 9 title-prefix matches, 13 with word prefixes, but 40 rows
    // once names are counted — so at offset 20 the ladder fell to broad with half the
    // supply unspent, and because broad is a different ordering over a different set
    // (author rows lead, title rows follow) the raw offset landed near the top of it and
    // page 3 reprinted page 1. On a v2 title search the two numbers coincide by
    // construction, which is one of the mismatches naming the side removes.
    //
    // An author search sits outside this ladder entirely — its escalation is "did any name
    // match at all", which fetchAuthorSearchPage decides from the branch's own result. The
    // value here is inert for it, and only kept well-defined so the rowsWhere/rowsOrderBy
    // expressions below stay total.
    const rowsTier: SearchTier = opts.q && !isAuthorSearch
      ? fastCount >= pageEnd
        ? 'fast'
        : exactBandCount > opts.offset
          ? 'cheap'
          : 'broad'
      : 'broad';

    // When a search query is present, relevance ranking takes priority and both
    // sortBy and sort are ignored — a page ordered by title that was *selected*
    // by fuzzy relevance is neither one thing nor the other. Otherwise order by
    // the requested field, falling back to updatedAt.
    // An author search's WHERE lives inside its own branch (the name match is a subquery
    // over book_contributors, not a predicate on books), so there is no title condition to
    // build for it — buildWhereClause with no extra condition is what its branch filters by.
    //
    // Built from an `opts` the caller supplies rather than from the closure, because the
    // shop's band ladder below re-runs it once per band — same tier, same ordering, one
    // extra predicate. `buildRowsWhere(opts)` (no band) is the whole filtered set, which
    // is what the count at the bottom must keep measuring.
    const buildRowsWhere = (o: ListBooksOptions) =>
      o.q && !isAuthorSearch
        ? buildWhereClause(
            o,
            rowsTier === 'fast'
              ? buildFastTitlePrefixCondition(o.q)
              : rowsTier === 'cheap'
                ? buildTitlePrefixCondition(o.q)
                : buildSearchCondition(o.q),
          )
        : buildWhereClause(o);
    const rowsWhere = buildRowsWhere(opts);

    // How many rows are in one band, for the offset arithmetic in planShopBands.
    //
    // Cached like the total is, and for the same reason: it is a count over the whole
    // filtered catalogue, it barely moves between requests, and every page of the same
    // shop listing needs the same answer — a boundary that differed page to page would
    // drop rows between pages or repeat them. The tier is part of the key because a
    // search's band is measured against whichever match set the tier ladder settled on,
    // and two tiers are two different sets.
    const countShopBand = async (band: ShopBand): Promise<number> => {
      const key = `books:shopband:v1:${band}:${rowsTier}:${createHash('sha256')
        .update(JSON.stringify(countFilters))
        .digest('hex')}`;
      const cached = await redis.get(key);
      if (cached != null) return parseInt(cached, 10);
      const count = await countUpTo(
        buildRowsWhere({ ...opts, shopBand: band }),
        opts.q ? SEARCH_COUNT_CAP + 1 : SHOP_BAND_COUNT_CAP,
      );
      await redis.set(key, String(count), 'EX', COUNT_TTL);
      return count;
    };
    const rowsOrderBy = opts.q && !isAuthorSearch
      ? rowsTier === 'fast'
        ? buildFastTitlePrefixOrderBy()
        : rowsTier === 'cheap'
          ? buildTitlePrefixOrderBy(opts.q)
          : buildSearchOrderBy(opts.q)
      : buildSortOrderBy(opts);

    // With dedupe on, over-fetch a headroom pool per page so collapsing same-titled
    // editions still tends to leave a full page — see DEDUPE_POOL_HEADROOM. Without it,
    // this is exactly opts.limit and every branch below reproduces prior behaviour.
    const overfetchLimit = opts.dedupe ? opts.limit + DEDUPE_POOL_HEADROOM : opts.limit;
    // Cursor-driven pagination is dedupe-only. `cursor.o` overrides `offset`
    // so the client hands back a resume position rather than tracking one.
    const effectiveOffset = opts.dedupe && opts.cursor ? opts.cursor.o : opts.offset;
    const carryOverTitles = new Set(opts.cursor?.t ?? []);

    const pagePromise: Promise<{ rows: BookListItem[]; hasMore: boolean; nextCursor: string | null }> = cachedRows
      ? Promise.resolve(JSON.parse(cachedRows) as { rows: BookListItem[]; hasMore: boolean; nextCursor: string | null }).then((parsed) => {
          for (const b of parsed.rows) {
            b.createdAt = new Date(b.createdAt);
            b.updatedAt = new Date(b.updatedAt);
          }
          return parsed;
        })
      : (async () => {
          // One page's worth of rows from one slice of the catalogue. `want` is a row
          // count, not a page size: every branch below is asked for exactly the number
          // of rows still missing, which is what lets the band ladder top up from the
          // next band when one runs dry mid-page.
          const fetchRawRows = async (
            fetchOpts: ListBooksOptions,
            offset: number,
            want: number,
          ): Promise<ListRow[]> => {
            const where = buildRowsWhere(fetchOpts);
            // The search branches take a page size and fetch one row beyond it, so a
            // request for `want` rows is a page size of want - 1.
            const pageSize = Math.max(0, want - 1);
            if (!fetchOpts.q) {
              return db
                .select(LIST_COLUMNS)
                .from(books)
                .where(where)
                .orderBy(...rowsOrderBy)
                .limit(want)
                .offset(offset);
            }
            if (isAuthorSearch) {
              return fetchAuthorSearchPage({ ...fetchOpts, offset }, fetchOpts.q, pageSize);
            }
            if (isBlendedSearch) {
              return fetchBlendedSearchPage(
                { ...fetchOpts, offset },
                fetchOpts.q,
                rowsTier,
                where,
                rowsOrderBy,
                pageSize,
                // Compared against the same offset the tier ladder above uses, so the
                // two decisions cannot disagree about whether this page is inside the
                // band.
                exactBandCount > offset,
              );
            }
            return fetchTitleSearchPage(
              { ...fetchOpts, offset },
              fetchOpts.q,
              rowsTier,
              where,
              rowsOrderBy,
              pageSize,
            );
          };

          // One row beyond the (possibly overfetched) page, so `hasMore` is known
          // without a second query — this is what callers should paginate on now
          // that `total` may be capped or, with dedupe, approximate.
          const want = overfetchLimit + 1;
          // Which band each row came from, so the response can carry `shoppable` per row
          // without a second lookup — the band the query selected already answers it.
          const bandByRow = new Map<number, ShopBand>();

          const fetched = !opts.shoppable
            ? await fetchRawRows(opts, effectiveOffset, want)
            : await (async () => {
                // The shop's ordering: walk the bands in order, mapping this page's
                // offset onto them. Each band's query is the ordinary one plus a
                // predicate, so every path keeps the index-backed plan it had — see
                // buildShopBandCondition for why the band cannot be an ORDER BY key.
                const [inStock, toOrder] = await Promise.all([
                  countShopBand(SHOP_BAND.IN_STOCK),
                  countShopBand(SHOP_BAND.TO_ORDER),
                ]);
                const planned = new Map(
                  planShopBands(effectiveOffset, want, { inStock, toOrder }).map(
                    (segment) => [segment.band, segment.offset] as const,
                  ),
                );
                // Bands ahead of the first planned one are entirely behind this offset.
                // Bands past it are fetched from the top, whether or not the plan
                // reached them: the counts are a snapshot of a table the hourly feed
                // writes to, so a band can be shorter than its count claimed, and only
                // the rows themselves are authoritative.
                const firstBand = planned.size > 0
                  ? Math.min(...planned.keys())
                  : SHOP_BAND.UNSELLABLE;

                const collected: ListRow[] = [];
                for (const band of SHOP_BAND_ORDER) {
                  if (band < firstBand) continue;
                  if (collected.length >= want) break;
                  const rows = await fetchRawRows(
                    { ...opts, shopBand: band },
                    planned.get(band) ?? 0,
                    want - collected.length,
                  );
                  for (const row of rows) bandByRow.set(row.id, band);
                  collected.push(...rows);
                }
                return collected;
              })();

          const rawHasMore = fetched.length > overfetchLimit;
          const rawRows = rawHasMore ? fetched.slice(0, overfetchLimit) : fetched;

          // The shop fields are looked up for the sellable bands only. An unsellable
          // book can still have a supplier price and even stock behind it — an
          // unsuppliable report code does not erase either — and reporting them
          // would put a number on a shelf nobody can buy from and a stock badge on
          // a row with no Add button. Neither is a fact the caller can act on, and
          // both read as an offer.
          const sellableIsbns = opts.shoppable
            ? rawRows
                .filter((r) => isSellableBand(bandByRow.get(r.id) ?? SHOP_BAND.UNSELLABLE))
                .map((r) => r.isbn13)
            : [];

          const [relations, excerptMap, descriptionById, stockByIsbn, priceByIsbn] = await Promise.all([
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
            // Only the shop needs the badge, so only the shop pays for the lookup.
            // One batched query over the page's ISBNs, not a column on LIST_COLUMNS:
            // adding it there would put the stock table into every tier's plan,
            // including the fast title-prefix scan whose speed comes from touching
            // nothing but its own index.
            opts.shoppable && sellableIsbns.length > 0
              ? availabilityService.inStockByIsbns(sellableIsbns)
              : Promise.resolve(new Map<string, boolean>()),
            // Same bargain as the stock badge: one batched query, and only when
            // the shop asked. Without it a client can filter on a price the
            // response never carries.
            opts.shoppable && sellableIsbns.length > 0
              ? availabilityService.livePricesByIsbns(sellableIsbns)
              : Promise.resolve(
                  new Map<string, { unitPriceGbpPence: number; compareAtGbpPence: number | null }>(),
                ),
          ]);
          const enriched = rawRows.map((r) => ({
            ...r,
            ...relations.get(r.id)!,
            excerpt: pickExcerpt(r.isbn13, excerptMap),
            // Absent entirely unless asked for. On a sellable row a missing stock
            // entry would mean the row vanished between the two queries — `false`
            // is the safe reading. On an unsellable one the shop fields are absent
            // by design, which is why the price and stock lookups above were never
            // asked about it.
            ...(opts.shoppable
              ? isSellableBand(bandByRow.get(r.id) ?? SHOP_BAND.UNSELLABLE)
                ? {
                    // The band the row was selected by, not a second opinion about
                    // it: whichever query returned this row had the band as a
                    // predicate, so this cannot disagree with the ordering the
                    // client is looking at.
                    shoppable: true,
                    inStock: r.isbn13 ? (stockByIsbn.get(r.isbn13) ?? false) : false,
                    ...priceFields(r.isbn13 ? priceByIsbn.get(r.isbn13) : undefined, opts.currency),
                  }
                : { shoppable: false }
              : {}),
          }));

          let hasMore = rawHasMore;
          let result: BookListItem[];
          let nextCursor: string | null = null;

          if (opts.dedupe) {
            // Drop any rows whose title was already returned on the previous
            // page. Same case-folded key that dedupeByTitle uses, so a match
            // here is exactly a match there.
            const carryOverFiltered = enriched.filter(
              (r) => !carryOverTitles.has(r.title.trim().toLowerCase()),
            );
            const scored = carryOverFiltered.map((r) => ({
              ...r,
              shortDescription: descriptionById.get(r.id) ?? null,
              genreCount: r.genres.length,
              hasPrice: r.prices.length > 0,
            }));
            const deduped = dedupeByTitle(scored);
            hasMore = hasMore || deduped.length > opts.limit;
            result = deduped.slice(0, opts.limit).map(({ shortDescription: _shortDescription, genreCount: _genreCount, hasPrice: _hasPrice, ...item }) => item);

            if (hasMore) {
              // Advance past everything we scanned and carry the returned
              // titles forward — those two guarantees together mean any raw
              // edition of a title on this page that lives past the page
              // boundary is filtered as a duplicate on the next request.
              const returnedKeys = result.map((r) => r.title.trim().toLowerCase());
              const nextTail = Array.from(
                new Set([...returnedKeys, ...(opts.cursor?.t ?? [])]),
              ).slice(-CURSOR_TAIL_TITLES);
              nextCursor = encodeDedupeCursor({
                o: effectiveOffset + rawRows.length,
                t: nextTail,
              });
            }
          } else {
            result = enriched;
          }

          const page = { rows: result, hasMore, nextCursor };
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
            // A degraded count must not be cached for COUNT_TTL — the next request should get
            // a fresh attempt rather than inherit this lower bound for the next half hour.
            if (!countProbeIncomplete) {
              await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
            }
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

    const [page, probedTotal] = await Promise.all([pagePromise, totalPromise]);
    // The tier probes count title and author matches only, so a search answered by the
    // broad (fuzzy) tier can report zero while returning a full page — "xylophonist" came
    // back as 20 books under a "0 results" caption, with hasMore true against a total of 0.
    // Counting the fuzzy tier properly is the unbounded work SEARCH_COUNT_CAP exists to
    // avoid, so the rows actually being returned stand in as a floor instead: never above
    // the truth, and never below what the caller is looking at. Searches only — a
    // filter-only browse keeps its exact count, where a disagreement would be a real bug
    // worth surfacing rather than papering over.
    // Only a non-empty page is evidence: returning n rows at offset k proves rows k..k+n-1
    // exist, so the total is at least k+n. An *empty* page proves nothing — paging past the
    // end of a 3-match result set would otherwise let offset alone invent a total of 40.
    const rowsFloor = opts.q && page.rows.length > 0 ? effectiveOffset + page.rows.length : 0;
    const total = Math.max(probedTotal, rowsFloor);
    // Derived rather than stored so it stays correct when `total` came from cache. `total`
    // counts raw rows, not distinct titles — computing an exact distinct-title count would
    // mean an unbounded GROUP BY over the same 1M+-row table SEARCH_COUNT_CAP exists to
    // avoid scanning, so dedupe forces this the same way a capped search count does: a
    // lower bound, with `hasMore` as the real pagination signal.
    const totalIsApproximate =
      (!!opts.q && total >= SEARCH_COUNT_CAP) ||
      !!opts.dedupe ||
      countProbeIncomplete ||
      // The floor only raises the total when the probes undercounted, which makes what we
      // report a lower bound by construction.
      total > probedTotal;
    return {
      books: page.rows,
      total,
      hasMore: page.hasMore,
      totalIsApproximate,
      nextCursor: page.nextCursor,
    };
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

    // The typeahead still blends both sides (see SuggestionType) and so still needs a
    // rule for which leads: titles do, unless nothing
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
  async trending(
    limit: number,
    userId?: number,
    currency?: string,
  ): Promise<TrendingBookItem[]> {
    const cacheTarget = limit + FEED_EXCLUSION_HEADROOM;
    // v5: the sellable filter no longer depends on `shoppable` (see
    // buildFeedCondition), so the pool is identical for shop and non-shop
    // callers — `shoppable` is out of the key, and the version bump drops the
    // pre-fix `:all` pools that still held unsellable books. (v4 keyed on
    // shoppable; v3 made the value a pool of cacheTarget items so per-viewer
    // filtering has spare rows to eat; v2 reweighted scores per interaction
    // type; v1 was the flat unweighted ranking.)
    const cacheKey = `trending:v5:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return attachShopFields(
        await applyUserExclusions(JSON.parse(cached) as TrendingBookItem[], userId, limit),
        currency,
      );
    }

    const since = new Date();
    since.setDate(since.getDate() - TRENDING_WINDOW_DAYS);

    const poolSize = Math.min(cacheTarget * feedPoolMultiplier(), FEED_POOL_MAX);

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
            buildFeedCondition(),
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
        .where(and(inArray(books.id, bookIds), buildFeedCondition())),

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
    // The pool is cached WITHOUT prices; attachShopFields runs after.
    await redis.set(cacheKey, JSON.stringify(pool), 'EX', TRENDING_TTL);
    return attachShopFields(await applyUserExclusions(pool, userId, limit), currency);
  },

  async personalized(
    userId: number,
    limit: number,
    currency?: string,
  ): Promise<TrendingBookItem[]> {
    // v3: sellable/withdrawn filtering is now unconditional here too, so the
    // pool is identical for shop and non-shop callers — `shoppable` is out of
    // the key, and the bump drops the pre-fix pools that were never filtered.
    const cacheKey = `personalized:v3:${userId}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return attachShopFields(JSON.parse(cached) as TrendingBookItem[], currency);
    }

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
      // Withdrawn and unsellable titles are excluded here like every other
      // feed. This query used to build its own WHERE and skip the shared
      // predicate, so the personalized shelf could surface a book the shop
      // cannot sell (or one Gardners had withdrawn) — the one feed that never
      // applied the filter at all.
      buildFeedCondition(),
      sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${PERSONALIZED_SIMILARITY_THRESHOLD}`,
      exclusions.bookIds.length > 0 ? notInArray(books.id, exclusions.bookIds) : undefined,
      // Catches other editions of an excluded book, which the ID list above
      // can't see — the catalogue stores each format as its own row.
      buildWorkExclusionCondition(exclusions.works),
    );

    const poolSize = Math.min(limit * feedPoolMultiplier(), FEED_POOL_MAX);

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

    // Cached without prices — attachShopFields runs on every read instead.
    await redis.set(cacheKey, JSON.stringify(results), 'EX', PERSONALIZED_TTL);
    return attachShopFields(results, currency);
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
    /**
   * "You may also like" for a whole basket rather than a single book.
   *
   * Averages the basket's embeddings and finds the nearest neighbours to that
   * centroid, which is why it is not just `similar()` run per book and merged:
   * a basket of one cookbook and two thrillers should surface something that
   * suits the *shopper*, not three separate lists stapled together.
   *
   * Stateless by design — the basket arrives as ids, because before sign-in it
   * lives on the client and there is no cart row to read.
   */
  async basketRecommendations(
    bookIds: number[],
    limit: number,
    userId?: number,
    currency?: string,
  ): Promise<BookListItem[]> {
    if (bookIds.length === 0) return [];

    const seeds = await db
      .select({ embedding: books.embedding })
      .from(books)
      .where(and(inArray(books.id, bookIds), eq(books.isRemoved, false)));

    const vectors = seeds.map((s) => s.embedding).filter((e): e is number[] => Array.isArray(e));
    // Every book in the basket is still awaiting its embedding — an empty list
    // is the honest answer, and the caller hides the section.
    if (vectors.length === 0) return [];

    const dimensions = vectors[0].length;
    const centroid = new Array<number>(dimensions).fill(0);
    for (const vector of vectors) {
      for (let i = 0; i < dimensions; i++) centroid[i] += vector[i];
    }
    for (let i = 0; i < dimensions; i++) centroid[i] /= vectors.length;

    const vectorLiteral = `[${centroid.join(',')}]`;
    const poolSize = Math.min((limit + FEED_EXCLUSION_HEADROOM) * feedPoolMultiplier(), FEED_POOL_MAX);

    // Ids only here, then hydrated through listByIds — the same serializer every
    // other book list uses, rather than a second one that drifts from it.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${HNSW_EF_SEARCH}`));
      return tx
        .select({ id: books.id })
        .from(books)
        .where(
          and(
            sql`${books.embedding} IS NOT NULL`,
            buildFeedCondition(),
            // Never recommend what is already in the basket.
            notInArray(books.id, bookIds),
          ),
        )
        .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
        .limit(poolSize);
    });

    if (rows.length === 0) return [];

    const hydrated = await booksService.listByIds(rows.map((row) => row.id));
    // listByIds makes no ordering promise, so re-impose similarity order.
    const byId = new Map(hydrated.map((book) => [book.id, book]));
    const ordered = rows
      .map((row) => byId.get(row.id))
      .filter((book): book is BookListItem => Boolean(book));

    // Signed-in shoppers do not get recommended books they have already
    // rejected. Guests have no exclusions to apply, which is the common case
    // here since the basket is client-held until sign-in.
    // Uncached, unlike the other feeds — but the price still goes on here rather
    // than in listByIds, so the shop fields ride one code path for every feed.
    if (userId === undefined) {
      return attachShopFields(ordered.slice(0, limit), currency);
    }

    const exclusions = await getUserExclusions(userId);
    return attachShopFields(
      filterExcludedWorks(ordered, exclusions).slice(0, limit),
      currency,
    );
  },

  async similar(
    bookId: number,
    limit: number,
    userId?: number,
    currency?: string,
  ): Promise<TrendingBookItem[]> {
    // Over-fetch target, so per-user filtering below has spare rows to eat.
    const cacheTarget = limit + FEED_EXCLUSION_HEADROOM;
    // v4: the sellable filter no longer depends on `shoppable`, so the pool is
    // identical for shop and non-shop callers — `shoppable` is out of the key,
    // and the bump drops the pre-fix `:all` pools that still held unsellable
    // books. (v3 keyed on shoppable; v2 made the value a pool of cacheTarget
    // items so per-user filtering has spare rows to eat.)
    const cacheKey = `similar:v4:${bookId}:${limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return attachShopFields(
        await applyUserExclusions(JSON.parse(cached) as TrendingBookItem[], userId, limit),
        currency,
      );
    }

    const [target] = await db
      .select({ embedding: books.embedding })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    // No embedding yet (migration still in progress)
    if (!target?.embedding) return [];

    const vectorLiteral = `[${target.embedding.join(',')}]`;

    const poolSize = Math.min(cacheTarget * feedPoolMultiplier(), FEED_POOL_MAX);

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
            buildFeedCondition(),
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
    // Cached without prices — see attachShopFields.
    return attachShopFields(await applyUserExclusions(pool, userId, limit), currency);
  },
};

/**
 * Drops books the viewer has rejected from an already-built list, then trims
 * to `limit`. Filtering happens here rather than in SQL because the list is a
 * per-book cache entry shared across users — see booksService.similar.
 *
 * Anonymous callers have nothing to exclude and skip the lookup entirely.
 */
/**
 * Puts live price and stock onto a feed's rows.
 *
 * Called at every feed's return point, *after* the cache read, for the reason
 * spelled out on TrendingBookItem: caching a price is the one thing the shop
 * must not do. Two batched lookups per request over the page's ISBNs — the same
 * bargain GET /books already makes, and only when the caller asked to shop.
 *
 * A book with no live stock row comes back without the fields rather than with
 * zeros: absent means "unknown", and a zero here reads as "free".
 */
/**
 * Adds the live shop fields to a feed's rows, after the cache and never inside
 * it — a cached price is a wrong price, and two visitors on the same cached
 * pool must not see each other's currency.
 *
 * Unconditional now: it used to take the caller's `shoppable` flag and return
 * the rows untouched without it, which is how a recommendation carousel ended
 * up rendering cards it had no price for. Every feed is a shop surface, so
 * every feed's rows are priced.
 *
 * Exported for the bestseller chart in commerce/, for the reason given on
 * buildFeedCondition: one code path for every feed's shop fields.
 */
export async function attachShopFields<T extends { isbn13: string | null }>(
  items: T[],
  currency: string | undefined,
): Promise<T[]> {
  if (items.length === 0) return items;

  const isbns = items.map((i) => i.isbn13);
  const [priceByIsbn, stockByIsbn] = await Promise.all([
    availabilityService.livePricesByIsbns(isbns),
    availabilityService.inStockByIsbns(isbns),
  ]);

  const code = (currency ?? config.commerce.currency.default).toUpperCase();

  return items.map((item): T => {
    if (!item.isbn13) return item;
    const live = priceByIsbn.get(item.isbn13);
    return {
      ...item,
      inStock: stockByIsbn.get(item.isbn13) ?? false,
      ...(live
        ? {
            unitPriceMinor: toPresentment(live.unitPriceGbpPence, code),
            compareAtMinor:
              live.compareAtGbpPence === null ? null : toPresentment(live.compareAtGbpPence, code),
            currency: code,
          }
        : {}),
    };
  });
}

async function applyUserExclusions(
  items: TrendingBookItem[],
  userId: number | undefined,
  limit: number,
): Promise<TrendingBookItem[]> {
  if (userId === undefined) return items.slice(0, limit);

  const exclusions = await getUserExclusions(userId);
  return filterExcludedWorks(items, exclusions).slice(0, limit);
}
