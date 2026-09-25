import { createHash } from 'crypto';
import { eq, ne, sql, and, or, ilike, inArray, asc, desc, gt, lte, notInArray, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../db';
import {
  books,
  bookContributors,
  bookGenres,
  bookPrices,
  bookSubjects,
  genres,
  userBooks,
  userInteractions,
  userPreferences,
  users,
  type Book,
  type BookContributor,
  type ReaderType,
  type Genre,
  type BookSubject,
  type BookPrice,
} from '../db/schema';
import { dedupeByTitle, dedupeByTitleAndSubtitle } from '../lib/dedupe';
import {
  buildHasAuthorCondition,
  buildWorkExclusionCondition,
  EMPTY_EXCLUSIONS,
  filterExcludedWorks,
  getUserExclusions,
} from '../lib/exclusions';
import { logger } from '../lib/logger';
import { normalisedNameSql, normaliseNameQuery } from '../lib/contributor-name';
import { splitCandidates, type SplitCandidate } from '../lib/search-split';
import { redis } from '../lib/redis';
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';
import {
  getReviewsByIsbns,
  pickReview,
  bookReviewsService,
  type BookReviewInfo,
} from './book-reviews.service';
import { getBiosByIsbns, bdsEnrichmentService, type AuthorBioInfo } from './bds-enrichment.service';
import { attributableContributor, type BioConfidence } from '../lib/author-bio-match';
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
  STOCK_TIER,
  type ShopBand,
  type StockTier,
} from '../lib/shoppable';
import { SHOP_CURRENCY, toPresentment } from './commerce/pricing';
import { config } from '../config';
import { getProductFormLabel } from '../lib/product-form';
import { addDisplayGenre, toDisplayGenres } from '../lib/genre-display';
import { genresService } from './genres.service';

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

// Above this many *estimated* rows, a filter-only browse reports the planner's estimate
// instead of counting. Sized so the exact count it still runs is an index scan measured in
// tens of milliseconds: below the threshold the filter is selective and the real number is
// nearly free, above it the query is the whole-catalogue aggregate that made a cold shop
// page take 5.5s on production. Not a cap in the SEARCH_COUNT_CAP sense — the number
// reported is the planner's own estimate of the full result, not a truncation of it, so it
// does not stop short of a paginating client the way a floor would.
const EXACT_COUNT_MAX_ROWS = 50_000;
// Backstop for when the planner was wrong about that. Generous against the tens of
// milliseconds the threshold is meant to buy, so it only ever fires on a genuine
// misestimate — the 9.5s Seq Scan in search-count-probes.test.ts is the precedent for the
// planner being confidently wrong about a catalogue-sized scan.
const COUNT_STATEMENT_TIMEOUT_MS = 3000;
// Ceiling on how many author matches a search will pull from book_contributors before
// ranking them — see buildAuthorMatchCondition. Sized well above any real author's
// catalogue (the most prolific names in the catalogue are in the low hundreds of titles)
// so it only ever truncates genuinely ambiguous fragments, where the rows past the cap
// were never going to be shown anyway.
const AUTHOR_MATCH_LIMIT = 5000;
// Per-arm ceiling for the split band's name probe — see buildSplitMatchSource.
//
// Deliberately well below AUTHOR_MATCH_LIMIT, because this probe issues two arms per
// candidate split rather than four arms total: at the widest it is twelve arms, and the
// rows they produce are joined against `books` before anything narrows them. The cap is
// what keeps that join proportional to the query rather than to how common a name
// fragment is, and it is generous against the thing it truncates — a run that matches
// more than this many contributor rows is a fragment like "har", not a name.
const SPLIT_NAME_LIMIT = 1500;
// How long a resolved split band survives in Redis.
//
// The same length as COUNT_TTL, and for the same reason: this list *is* the split band's
// count as well as its ranking, so the two must expire together or a page would report a
// total from one generation against rows from another.
const SPLIT_TTL = 30 * 60;
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
  /**
   * A genre slug as the client sent it — a top-level family slug from
   * `GET /genres` or a book's genres, or an older stored full slug. list()
   * resolves it into `genreIds` before anything reads it; filters use only that.
   */
  genre?: string;
  /**
   * The stored genre ids `genre` stands for (see genresService.idsForSlug). Set by
   * list(), never by a caller. Carried in opts rather than resolved inside the
   * WHERE so every cache key hashed from opts changes when a family gains a genre.
   */
  genreIds?: number[];
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
  productFormLabel: string | null;
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
  /**
   * How many copies one customer may buy right now — see availableQuantityFor
   * in lib/shoppable. Always present on `GET /books` and `GET /books/:id`,
   * whatever `shoppable` says; 0 means it cannot be bought at the moment.
   * Optional only because internal builders of this shape (listByIds, saved
   * books) do not attach it themselves.
   */
  availableQuantity?: number;
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
  productFormLabel: string | null;
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
  productFormLabel: string | null;
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
  /** See BookListItem.availableQuantity. */
  availableQuantity?: number;
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

function stripFeedScoring(row: FeedScoringRow & { stockTier?: number }): TrendingBookItem {
  const { shortDescription: _shortDescription, availabilityCode: _availabilityCode, genreCount: _genreCount, hasPrice: _hasPrice, stockTier: _stockTier, ...item } = row;
  return item;
}

// A row off the reader-type cohort query. Snake_case because it comes back from
// raw SQL rather than the query builder, and `total` rides on every row — it is
// a `count(*) OVER ()` window, so each row carries the same value.
interface ReaderTypeFeedRow {
  id: number;
  title: string;
  subtitle: string | null;
  cover_url: string | null;
  isbn13: string | null;
  product_form: string | null;
  publication_date: string | null;
  liker_count: number;
  total: number;
}

/**
 * Turns bare catalogue rows into the card shape the feeds return: contributors,
 * genres and an excerpt attached, input order preserved.
 *
 * Deliberately does **not** attach shop fields. Every other feed in this file is
 * a shop surface and calls attachShopFields on the way out; the reader-type rail
 * is a discovery carousel with no Add button, so it carries no price. If that
 * rail ever gains one, this is a one-line change at the call site rather than a
 * different query — but it must be attachShopFields on every request, never a
 * cached price. See the note on TrendingBookItem for why that rule is absolute.
 */
async function hydrateBookCards(
  rows: { id: number; title: string; subtitle: string | null; cover_url: string | null; isbn13: string | null; product_form: string | null; publication_date: string | null }[],
): Promise<TrendingBookItem[]> {
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
      .where(inArray(bookGenres.bookId, ids))
      // Fixed order so that when several genres share a display name the same
      // one's slug is kept on every read (see lib/genre-display).
      .orderBy(genres.id),

    getExcerptsByIsbns(rows.map((r) => r.isbn13)),
  ]);

  const bookMap = new Map<number, TrendingBookItem>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        coverUrl: r.cover_url,
        isbn13: r.isbn13,
        productForm: r.product_form,
        productFormLabel: getProductFormLabel(r.product_form),
        publicationDate: r.publication_date,
        contributors: [] as TrendingBookItem['contributors'],
        genres: [] as TrendingBookItem['genres'],
        excerpt: pickExcerpt(r.isbn13, excerptMap),
      },
    ]),
  );

  for (const c of contributors) {
    bookMap.get(c.bookId)?.contributors.push({
      role: c.role,
      personName: c.personName,
      sequenceNumber: c.sequenceNumber,
    });
  }
  for (const g of genreRows) {
    const entry = bookMap.get(g.bookId);
    if (entry) addDisplayGenre(entry.genres, g);
  }

  return rows.map((r) => bookMap.get(r.id)).filter((b): b is TrendingBookItem => b !== undefined);
}

/**
 * Another format of the same title, offered alongside a book's detail page.
 *
 * Deliberately minimal — just enough for a client to render "Also available
 * as: Hardback / E-book" links through to the sibling's own detail page.
 */
export interface EditionSummary {
  id: number;
  isbn13: string | null;
  productForm: string | null;
  productFormLabel: string | null;
  coverUrl: string | null;
  publicationDate: string | null;
  /** Live, put on after the book-page cache — see booksService.getById. */
  availableQuantity?: number;
}

/** A book-page contributor, with the biography when it is safely theirs. */
export interface DetailContributor extends Pick<BookContributor, 'role' | 'personName' | 'sequenceNumber'> {
  bio?: { bioHtml: string; confidence: BioConfidence };
}

export interface BookDetail extends BookListItem {
  /**
   * Review quotes from Nielsen or, where Nielsen has none, from BDS — `source`
   * says which. HTML as supplied, with the outlet names embedded in the prose
   * rather than as separate fields. Renders the same way longDescription
   * does, and needs the same treatment by the client.
   */
  review: BookReviewInfo | null;
  /**
   * The author biography from BDS, as HTML. One block per book — it can cover
   * several contributors — so it stays at book level. Where it can safely be
   * attributed to one person it *also* appears on that contributor; see
   * lib/author-bio-match.
   */
  authorBio: AuthorBioInfo | null;
  /**
   * Contributors, each carrying `bio` when this book's biography is
   * demonstrably about them: they are the book's only author, and the text
   * names them. Absent otherwise — an edited collection's biography covers
   * several people and belongs to none of them.
   */
  contributors: DetailContributor[];
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
  /**
   * Other editions of this same title — matched on exact title (an indexed
   * column, no fuzzy scan) plus at least one shared contributor, normalised
   * the same way name search is (see lib/contributor-name.ts, since ~22% of
   * contributor rows have doubled internal spaces and an exact string match
   * would silently miss them). Publisher is deliberately not compared:
   * formats are routinely split across imprints and public-domain titles are
   * reissued by unrelated houses, so requiring it to match returned nothing
   * for the titles readers most often open.
   *
   * Gardners' ONIX feed has no publisher-supplied "other formats" link
   * (checked: no `<RelatedProduct>` anywhere in it), so this is a heuristic,
   * not a supplier-asserted fact — it can miss a real sibling edition (title
   * text drifted between editions) or, in principle, match two different
   * works that share both an exact title and a contributor. Since publisher
   * no longer narrows it, expect adjacent editions rather than strictly the
   * trade formats: a study edition or an annotated critical edition of the
   * same work by the same author qualifies. Empty when the book has no
   * identifying contributors at all, rather than falling back to
   * title-only matching, and capped at OTHER_EDITIONS_LIMIT.
   */
  otherEditions: EditionSummary[];
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
  const code = SHOP_CURRENCY;
  return {
    unitPriceMinor: toPresentment(live.unitPriceGbpPence, code),
    compareAtMinor:
      live.compareAtGbpPence === null ? null : toPresentment(live.compareAtGbpPence, code),
    currency: code,
  };
}

/**
 * Sorts a title-ordered page into three bands, letters first.
 *
 * The catalogue mixes three kinds of title, and left to plain ASCII order the
 * two uninteresting kinds come first: punctuation-only rows (`?`, `.`, `...`,
 * `-`, the odd empty string) beat everything, and symbol- or digit-led titles
 * (`1984`, `£10 Dinners`, `!!! Wow`) beat every letter. Both used to occupy the
 * first page of `sortBy=title&sort=asc`. This is the rank they sort on before
 * the title itself:
 *
 * - `0` — starts with a letter. The great majority of the catalogue.
 * - `1` — starts with a digit or a symbol, but has a letter or digit somewhere.
 * - `2` — no letter or digit anywhere, or NULL. The placeholders.
 *
 * The first character is read *after* stripping leading decoration — quotes
 * (straight, curly and guillemet), an apostrophe, `#`, inverted Spanish
 * punctuation, and whitespace. Without that, band 1 buries real books rather
 * than the intended junk: quoted titles (`"The Nose"`) appear four times in a
 * 1000-row sample of the live catalogue, and `'Tis the Season`, `#Girlboss` and
 * `¿Quién?` are all the same shape. Stripping is deliberately limited to
 * decoration around a word — a title genuinely opening on `£`, `!` or `(` still
 * sinks, which is what "starting with a symbol" was asked for.
 *
 * The *same* stripped form is then what band 0 sorts on, and that half is not
 * optional. Ranking `"Brother Woodrow"` as a real book while still ordering it
 * on the raw string only moves the problem: `"` sorts below every letter, so
 * the quoted titles leave the bottom of the page and take over the top of it
 * instead — page one of A–Z was eight `"…"` titles before this second key
 * existed. Sorting on the stripped form files them under `B`, where a reader
 * looking for them would go. The raw title follows as a tiebreak, so two titles
 * differing only in their decoration still have one stable order to page
 * through rather than an arbitrary one.
 *
 * The `IS NULL` arm is load-bearing and not defensive tidiness: `NULL !~ '...'`
 * is NULL rather than true, so without it the CASE falls past both WHENs and a
 * NULL title lands in band 1, above the placeholders it belongs with. (The
 * column is NOT NULL today, so this decides nothing in practice — but it is the
 * arm that would be silently wrong if that ever loosened.)
 *
 * `COLLATE "und-x-icu"` is what makes `[[:alpha:]]` mean *letter* rather than
 * *ASCII letter*. Postgres derives a regex character class from the operand's
 * ctype, and this database is `datctype = 'C'`, under which `'É' ~ '[[:alpha:]]'`
 * is false — so uncollated, the rank sinks `Élégance`, `Öl und Wein`, `Čapek`,
 * `Москва` and `東京` into band 1 alongside the symbols, and an all-accented
 * title into band 2 as junk. The ICU collation is also why the classification
 * cannot drift between environments: it no longer depends on the ctype the
 * database happened to be created with. `und` (root) rather than a language,
 * because the catalogue is not in one language and only character *classes* are
 * being read here, never sort order.
 *
 * This expression is duplicated in three other places and the copies have to
 * stay character-identical or the planner stops matching the index built for it
 * — see docs/title-sort-index-rollout.md.
 */
const TITLE_SORTED_ON = sql`regexp_replace(${books.title} COLLATE "und-x-icu", '^[[:space:]''"#¡¿“”‘’«»‹›]+', '')`;

const TITLE_SORT_RANK = sql`(CASE WHEN ${books.title} IS NULL OR ${books.title} COLLATE "und-x-icu" !~ '[[:alnum:]]' THEN 2 WHEN ${TITLE_SORTED_ON} ~ '^[[:alpha:]]' THEN 0 ELSE 1 END)`;

export function buildSortOrderBy(opts: ListBooksOptions): (SQL | PgColumn)[] {
  // The rank is always ASC, including when the title is DESC: "at the bottom"
  // is a statement about the page, not about the sort direction, so reversing
  // the title must not float the sunk bands to the top. That asymmetry is also
  // why it takes two indexes rather than one read backwards — see
  // 0061_books_title_sortable_rank_v2.sql.
  // `books.id` last on the title and newest orders makes them total: without it,
  // editions sharing a title or a publication date come back in whatever order
  // the scan happens to produce, so two requests for adjacent pages can disagree
  // about which side of the boundary a row is on. Ties there are small (one
  // title's editions, one day's releases), so the incremental sort is cheap.
  //
  // Deliberately not added to the default updatedAt order: bulk loads stamp a
  // whole batch with one timestamp, so its tie groups can be a large share of
  // the catalogue, and sorting one per page needs an (updated_at, id) index first.
  const byTitle = (): SQL[] => {
    const dir = opts.sort === 'desc' ? sql`DESC` : sql`ASC`;
    return [TITLE_SORT_RANK, sql`${TITLE_SORTED_ON} ${dir}`, sql`${books.title} ${dir}`, sql`${books.id} ${dir}`];
  };

  switch (opts.sortBy) {
    case 'title':
      return byTitle();
    case 'newest':
      return [
        sql`${books.publicationDate} ${opts.sort === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`,
        sql`${books.id} ${opts.sort === 'asc' ? sql`ASC` : sql`DESC`}`,
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

  if (opts.genreIds) {
    // An unknown slug resolves to no ids, and filters to no books, as it did when
    // this matched the slug directly.
    conditions.push(
      opts.genreIds.length === 0
        ? sql`false`
        : sql`${books.id} IN (
            SELECT bg.book_id FROM book_genres bg
            WHERE bg.genre_id IN (${sql.join(opts.genreIds.map((id) => sql`${id}`), sql`, `)})
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
      .where(inArray(bookGenres.bookId, ids))
      // Fixed order so that when several genres share a display name the same
      // one's slug is kept on every read (see lib/genre-display).
      .orderBy(genres.id),

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
    const entry = map.get(g.bookId);
    if (entry) addDisplayGenre(entry.genres, g);
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

/**
 * Splits a cached total into the number and whether it was estimated rather than counted.
 *
 * Estimates are stored with a leading `~`, because the distinction has to survive the
 * cache. Without it the one request that computed an estimate would report
 * `totalIsApproximate` honestly and every request served from its entry for the rest of
 * COUNT_TTL would report the same number as exact.
 */
function parseCachedCount(raw: string | null): { total: number; isEstimate: boolean } {
  if (raw == null) return { total: 0, isEstimate: false };
  const isEstimate = raw.startsWith('~');
  const parsed = parseInt(isEstimate ? raw.slice(1) : raw, 10);
  return { total: Number.isNaN(parsed) ? 0 : parsed, isEstimate };
}

/**
 * What the planner expects a filtered catalogue scan to return, without running it.
 *
 * `EXPLAIN` without `ANALYZE` executes nothing: Postgres plans the query and reports the
 * row estimate it chose the plan on, in about a millisecond regardless of how large that
 * estimate is. That makes it usable as the *decision* about whether an exact count is
 * affordable, rather than as a consolation prize after one has already run long.
 *
 * Returns null when the plan cannot be read — a shape change in the EXPLAIN output, or a
 * predicate Postgres refuses to plan. A caption is not worth failing a browse over, so the
 * caller reads null as "no opinion" and counts for real.
 */
async function estimateFilteredRows(where: SQL | undefined): Promise<number | null> {
  try {
    const rows = await db.execute(
      sql`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${books} WHERE ${where ?? sql`TRUE`}`,
    );
    const plan = (rows as unknown as Record<string, unknown>[])[0]?.['QUERY PLAN'];
    const parsed = typeof plan === 'string' ? (JSON.parse(plan) as unknown) : plan;
    const estimate = (parsed as [{ Plan?: { 'Plan Rows'?: number } }] | undefined)?.[0]?.Plan?.[
      'Plan Rows'
    ];
    return typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : null;
  } catch (err) {
    logger.warn('Count estimate failed — falling back to an exact count', {
      error: (err as Error).message,
    });
    return null;
  }
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

// ---------------------------------------------------------------------------------------
// The split band: queries that name a book *and* a person in one string.
// ---------------------------------------------------------------------------------------
//
// "half of a yellow sun adichie", "rowling harry potter", "things fall apart achebe". None
// of these is a title and none is a name, so every cheap tier misses: the title tiers match
// a prefix of the whole string and the name tiers match a prefix of a person_name, and the
// whole string is neither. Before this band existed they fell straight through to the fuzzy
// title pool — the slowest query the search issues (see BROAD_CANDIDATE_POOL) and, for this
// shape, an answer to a question nobody asked, since it ranks near-misses on a string that
// was never one title.
//
// So this band sits *between* the exact band and the fuzzy one, and it is entered on
// exactly the condition that used to send a query to the fuzzy pool: nothing matched
// exactly, by title or by name, anywhere. A query the exact band answers never reaches it
// and pays nothing. A single-token query produces no candidate splits at all (see
// splitCandidates) and also pays nothing — which matters, because single-token typos are
// what the fuzzy pool legitimately exists for and they must not get slower.
//
// The split is not guessed. splitCandidates proposes every contiguous way the tokens could
// divide, and the probe below scores each proposal *per book* against the catalogue, keeping
// the best. That is what makes "harry potter rowling" work: the run "harry" matches real
// contributors and so does "rowling", but only under the "rowling" reading do the leftover
// words "harry potter" appear in that author's titles. Picking one global winner up front
// would have needed a tie-break rule with no evidence behind it; scoring per book means the
// evidence decides, and it is the same join either way.

/**
 * The name side of the split band: one bounded index arm per candidate run, per match shape.
 *
 * Two arms per candidate, mirroring the tiers buildAuthorMatchSource already uses and for
 * the same reasons:
 *   - a plain-prefix arm on `lower(normalised person_name) LIKE 'run%'`, which
 *     idx_book_contributors_name_lower_pattern serves as a range scan. This is the arm that
 *     catches "chimamanda ngozi adichie" and, because the feed stores some names inverted
 *     ("Achebe, Chinua"), a good share of surname-first rows too.
 *   - a word-prefix arm on `normalised person_name ILIKE '% run%'`, which the trigram GIN
 *     serves. This is the arm that catches a bare surname, and it is not optional: most
 *     readers type "adichie", which is a prefix of nothing.
 *
 * Every arm carries its own LIMIT. A single cap over the union would let one popular
 * fragment produce its whole match set before the merge could discard it, which is the
 * unbounded-work shape SEARCH_COUNT_CAP and AUTHOR_MATCH_LIMIT both exist to prevent.
 *
 * `run` tags each row with which candidate produced it, because the score below has to know
 * which leftover words to look for — the arms cannot compute that themselves, since they
 * never see `books`.
 *
 * Roles are carried, not filtered. Same rule as the name tiers: A01 ranks above editors and
 * translators, but an edited volume found by its editor's name is a real result, and about
 * one book in five has no A01 contributor at all.
 */
function buildSplitMatchSource(candidates: SplitCandidate[]): SQL {
  // Interpolated raw and character-identical to the index definition in db/setup.ts — see
  // normalisedNameSql. A drift here is a silent sequential scan over book_contributors,
  // which is precisely the cost this band exists to avoid.
  const NAME = sql.raw(normalisedNameSql('bc.person_name'));

  const arms: SQL[] = [];
  candidates.forEach((candidate, index) => {
    // Normalised on this side because the column is normalised on the other — the feed
    // ships ~22% of contributor rows with doubled internal spaces, and LIKE is literal.
    const name = normaliseNameQuery(candidate.name);
    const run = sql.raw(String(index));
    const runLength = sql.raw(String(candidate.nameTokens.length));

    arms.push(sql`(
      SELECT bc.book_id, ${run} AS run, ${runLength} AS run_len, bc.role
      FROM book_contributors bc
      WHERE lower(${NAME}) LIKE lower(${name + '%'})
      LIMIT ${SPLIT_NAME_LIMIT}
    )`);
    arms.push(sql`(
      SELECT bc.book_id, ${run} AS run, ${runLength} AS run_len, bc.role
      FROM book_contributors bc
      WHERE bc.person_name IS NOT NULL
        AND ${NAME} ILIKE ${'% ' + name + '%'}
      LIMIT ${SPLIT_NAME_LIMIT}
    )`);
  });

  return sql`(${sql.join(arms, sql` UNION ALL `)})`;
}

/**
 * How many of a candidate's leftover words appear in the book's title.
 *
 * A `CASE` over the run tag, because each candidate leaves different words behind. Written
 * as a sum of per-word tests rather than one combined pattern so that a partial match still
 * scores: "harry potter rowling" read as name="rowling" leaves "harry" and "potter", and a
 * book matching both must outrank one matching only "harry".
 *
 * Plain `ILIKE '%word%'` with no index behind it, which is affordable only because of where
 * this is evaluated: the rows it runs against are already the bounded output of the name
 * arms joined to `books` by primary key, not the catalogue. Anything more clever here would
 * be optimising the cheap half.
 */
function buildSplitTitleHits(candidates: SplitCandidate[]): SQL {
  const branches = candidates.map((candidate, index) => {
    const tests = candidate.titleMatchTokens.map(
      (token) => sql`(CASE WHEN ${books.title} ILIKE ${'%' + token + '%'} THEN 1 ELSE 0 END)`,
    );
    return sql`WHEN ${sql.raw(String(index))} THEN (${sql.join(tests, sql` + `)})`;
  });
  return sql`(CASE m.run ${sql.join(branches, sql` `)} ELSE 0 END)`;
}

/** How many leftover words that candidate had, so the hit count can be read as a proportion. */
function buildSplitTitleNeed(candidates: SplitCandidate[]): SQL {
  const branches = candidates.map(
    (candidate, index) =>
      sql`WHEN ${sql.raw(String(index))} THEN ${sql.raw(String(candidate.titleMatchTokens.length))}`,
  );
  // splitCandidates never leaves a candidate with zero title tokens, so the ELSE is
  // unreachable — it is 1 rather than 0 because it divides.
  return sql`(CASE m.run ${sql.join(branches, sql` `)} ELSE 1 END)`;
}

/**
 * The split band's ranking, as one integer per (book, candidate) pair. Higher is better.
 *
 * Packed into a single expression rather than several ordered columns because the whole
 * point is to take the *best interpretation per book*: `MAX()` over one number keeps a
 * book's keys from being mixed across two different readings of the query, which is what
 * `MAX(hits), MAX(run_len)` would silently do.
 *
 * The fields, most significant first:
 *   - the proportion of leftover words found in the title, as thousandths. This dominates
 *     everything, and it is what resolves an ambiguous split: a reading under which every
 *     remaining word appears in the title beats one under which half of them do.
 *   - the length of the name run, so that where two readings match the title equally, the
 *     one claiming more of the query as a name wins. "chimamanda ngozi adichie" is a more
 *     specific claim than "chimamanda".
 *   - whether the contributor is credited A01, as the last tiebreak, keeping an author
 *     above an editor of the same book.
 *
 * The weights do not overlap: the proportion is 0-1000 scaled by 100, and the two tiebreaks
 * together can never exceed 31.
 */
function buildSplitScore(hits: SQL, need: SQL): SQL {
  return sql`(((${hits}) * 1000 / (${need})) * 100 + s.run_len * 10 + CASE WHEN s.role = 'A01' THEN 1 ELSE 0 END)`;
}

/**
 * Resolves the split band to a ranked list of book ids, filtered and capped, and caches it.
 *
 * Materialising the whole band rather than one page of it is deliberate, and it buys three
 * things at once:
 *
 *   - **The count.** The list's length *is* the band's total, exact up to SEARCH_COUNT_CAP,
 *     so this band needs no count probe of its own. That matters because the probes it
 *     would otherwise reuse all measure the exact band, which for any query reaching here
 *     is empty by definition — a split search would report "0 results" over a full page.
 *
 *   - **Page stability.** Every page slices the same list, so a book cannot appear on two
 *     pages or on none as the offset advances. The alternative — re-running the ranking per
 *     page with a wider LIMIT — is the resampling hazard rankAuthorMatches and rankBroadPool
 *     both document, and this band is more exposed to it than either, because its score ties
 *     heavily (most books match the same proportion of leftover words).
 *
 *   - **The cost, once.** The cap is 1001 ids, so the whole band is a few kilobytes in
 *     Redis, and every subsequent page of that search is a cache read instead of a query.
 *
 * The filters are applied here rather than to the page fetch, so the ids are already the
 * caller's result set. That is why fetchSplitSearchPage can slice them without re-filtering.
 *
 * A timeout returns an empty list, which reads as "this band has nothing" and drops the
 * search to the fuzzy tier it would have used anyway. Bounded by PROBE_STATEMENT_TIMEOUT_MS
 * rather than BROAD_TIME_BUDGET_MS: this band is meant to be fast, and a slow one is a
 * failing index, not a dense neighbourhood to be waited out.
 */
async function resolveSplitBandIds(
  opts: ListBooksOptions,
  candidates: SplitCandidate[],
): Promise<number[]> {
  // Keyed on everything that changes the set, which is the filters (shopBand among them,
  // since the band ladder scopes each fetch to one) and the query itself. Derived by
  // removing the page-shaped fields for the same reason countCacheKey is: a filter added
  // to ListBooksOptions and forgotten here would silently serve one filter's band to
  // another.
  const {
    sort: _sort,
    sortBy: _sortBy,
    limit: _limit,
    offset: _offset,
    dedupe: _dedupe,
    cursor: _cursor,
    currency: _currency,
    ...keyed
  } = opts;
  const cacheKey = `books:split:v1:${createHash('sha256')
    .update(JSON.stringify(keyed))
    .digest('hex')}`;

  const cached = await redis.get(cacheKey);
  if (cached != null) return JSON.parse(cached) as number[];

  const hits = buildSplitTitleHits(candidates);
  const need = buildSplitTitleNeed(candidates);
  const filters = buildWhereClause(opts);

  // Two levels, so the leftover-word count is computed once rather than repeated in both
  // the filter and the ranking. It is the widest expression in the query — one CASE arm per
  // candidate, each a sum of per-word tests — and writing it twice would double the work and
  // leave two copies to drift apart.
  //
  // The `hits >= 1` filter is the band's definition. Without it a run like "harry" pulls in
  // every book by every contributor named Harry, which is the name half alone — something
  // the author branch already covers and the exact band already ruled out — and buries the
  // books the reader actually asked for underneath them.
  const ids = await withStatementTimeout(PROBE_STATEMENT_TIMEOUT_MS, async (conn) => {
    const ranked = await conn.execute<{ id: number }>(sql`
      SELECT s.id
      FROM (
        SELECT ${books.id} AS id,
               ${books.title} AS title,
               (${hits}) AS hits,
               (${need}) AS need,
               m.run_len,
               m.role
        FROM ${books}
        JOIN ${buildSplitMatchSource(candidates)} m ON m.book_id = ${books.id}
        WHERE ${filters ?? sql`TRUE`}
      ) s
      WHERE s.hits >= 1
      GROUP BY s.id, s.title
      ORDER BY MAX(${buildSplitScore(sql`s.hits`, sql`s.need`)}) DESC, lower(s.title), s.id
      LIMIT ${SEARCH_COUNT_CAP + 1}
    `);
    return (ranked as unknown as { id: number }[]).map((row) => Number(row.id));
  }).catch((err: unknown) => {
    if (!isStatementTimeout(err)) throw err;
    logger.warn('Split search band hit its budget — falling through to the fuzzy tier', {
      q: opts.q,
    });
    return [] as number[];
  });

  await redis.set(cacheKey, JSON.stringify(ids), 'EX', SPLIT_TTL);
  return ids;
}

/**
 * One page of the split band, sliced out of its resolved id list.
 *
 * No filtering and no ranking happen here — resolveSplitBandIds did both, which is what
 * makes this a primary-key fetch and nothing more. The in-memory re-sort is only to undo
 * the ordering `inArray` discards, exactly as fetchBroadTitleBranch does.
 *
 * Returns one row beyond the page so the caller can derive `hasMore` without a second query.
 */
async function fetchSplitSearchPage(
  opts: ListBooksOptions,
  ids: number[],
  pageSize: number,
): Promise<ListRow[]> {
  const pageIds = ids.slice(opts.offset, opts.offset + pageSize + 1);
  if (pageIds.length === 0) return [];

  const rows = await db.select(LIST_COLUMNS).from(books).where(inArray(books.id, pageIds));
  const rank = new Map(pageIds.map((id, i) => [id, i]));
  rows.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return rows;
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

// Generic writing credits, not identifying names — verified against production data
// (2026-09-04): rows with these as their only contributor consistently pair with a
// placeholder title too (e.g. "SOS TITLE UNKNOWN" / publisher "Not Stated", 49 rows
// in one cluster alone, all crediting "UNKNOWN"). Sharing one of these is not evidence
// two books are the same work — it is evidence both are missing real metadata — so
// they are excluded from the match rather than treated as a shared identity. Matched
// as a normalised whole name, not a substring: "Manon Tremblay" and "Canon Mark
// Oakley" are real people who must not be caught by a loose LIKE '%anon%'.
const GENERIC_CONTRIBUTOR_NAMES = ['UNKNOWN', 'VARIOUS', 'VARIOUS AUTHORS', 'ANONYMOUS', 'ANON', 'NOT STATED'];

/** Most siblings ever returned for one book — see fetchOtherEditions. */
const OTHER_EDITIONS_LIMIT = 20;

/**
 * Other editions of `title` (exact match — `idx_books_title` covers it, no
 * scan), sharing at least one *identifying* contributor with `id`.
 *
 * **Publisher is deliberately not part of the match.** It was, until a
 * paperback of *Animal Farm* (Nick Hern Books) came back with nothing: eight
 * other editions shared its exact title and credited George Orwell — Pan
 * Macmillan's hardback among them — and every one was rejected purely for
 * carrying a different publisher. That is the normal shape of a reissued
 * title rather than an edge case: a work out of copyright is published by
 * many unrelated houses, formats are often split across imprints, and a
 * large slice of the catalogue carries the placeholder publisher
 * `Not Stated`. Requiring publishers to agree guaranteed an empty list for
 * exactly the famous titles a reader is most likely to open.
 *
 * The contributor check is what keeps this from matching two unrelated books
 * that happen to share a title: it requires a shared row in
 * `book_contributors`, name-normalised on both sides the same way author
 * search is (see lib/contributor-name.ts — ~22% of contributor rows have
 * doubled internal spaces from the ONIX feed, so a plain string comparison
 * would silently miss real siblings) and excluding GENERIC_CONTRIBUTOR_NAMES
 * (see above — otherwise every "Various"-credited anthology in the catalogue
 * would match every other one). A book with zero *identifying* contributors
 * of its own matches nothing here rather than falling back to title-only.
 *
 * **Both stored spellings of every name are compared**, because the feed is
 * not consistent about which order it puts a name in. Verified in production
 * 2026-09-07: two Penguin editions of *Things Fall Apart* — same title, same
 * publisher, same author — stored their contributor as `Chinua Achebe` on one
 * row and `Achebe, Chinua` on the other, and matching `person_name` alone
 * found nothing. Each side therefore contributes both `person_name` and
 * `person_name_inverted` to the comparison, and a hit on any pairing counts:
 * the natural-order row matches on its own inverted form, which is the
 * spelling the other row happens to have kept.
 *
 * Capped at OTHER_EDITIONS_LIMIT. Without the publisher narrowing the
 * candidate set is every book sharing the title, and a placeholder title can
 * be carried by thousands of rows — the cap bounds both the payload and the
 * work the join has to do for one of those.
 */
async function fetchOtherEditions(
  id: number,
  title: string,
): Promise<Pick<EditionSummary, 'id' | 'isbn13' | 'productForm' | 'coverUrl' | 'publicationDate'>[]> {
  const CANDIDATE_NAME = sql.raw(normalisedNameSql('book_contributors.person_name'));
  const CANDIDATE_NAME_INVERTED = sql.raw(normalisedNameSql('book_contributors.person_name_inverted'));
  const OWN_NAME = sql.raw(normalisedNameSql('person_name'));
  const OWN_NAME_INVERTED = sql.raw(normalisedNameSql('person_name_inverted'));
  const notGeneric = (nameExpr: SQL) =>
    sql`upper(${nameExpr}) NOT IN (${sql.join(
      GENERIC_CONTRIBUTOR_NAMES.map((n) => sql`${n}`),
      sql`, `,
    )})`;

  // Every spelling this book credits, in both stored orders. UNION rather than
  // UNION ALL: a row whose two columns hold the same string contributes once.
  const ownNames = sql`(
    SELECT ${OWN_NAME} AS name FROM book_contributors
     WHERE book_id = ${id} AND person_name IS NOT NULL AND ${notGeneric(OWN_NAME)}
    UNION
    SELECT ${OWN_NAME_INVERTED} AS name FROM book_contributors
     WHERE book_id = ${id} AND person_name_inverted IS NOT NULL AND ${notGeneric(OWN_NAME_INVERTED)}
  )`;

  return db
    .selectDistinct({
      id: books.id,
      isbn13: books.isbn13,
      productForm: books.productForm,
      coverUrl: books.coverUrl,
      publicationDate: books.publicationDate,
    })
    .from(books)
    .innerJoin(bookContributors, eq(bookContributors.bookId, books.id))
    .where(
      and(
        eq(books.title, title),
        eq(books.isRemoved, false),
        ne(books.id, id),
        sql`(
          (${notGeneric(CANDIDATE_NAME)} AND ${CANDIDATE_NAME} IN (SELECT name FROM ${ownNames} AS own_names))
          OR
          (book_contributors.person_name_inverted IS NOT NULL
             AND ${notGeneric(CANDIDATE_NAME_INVERTED)}
             AND ${CANDIDATE_NAME_INVERTED} IN (SELECT name FROM ${ownNames} AS own_names_inv))
        )`,
      ),
    )
    .limit(OTHER_EDITIONS_LIMIT);
}

/**
 * Most sibling editions considered per title on one `GET /books` page — see
 * fetchSiblingEditions. A classic can have hundreds; the best-stocked few are all
 * the picker needs, and a per-title cap stops one of them crowding every other
 * title on the page out of a shared limit.
 */
const SIBLING_EDITIONS_PER_TITLE = 10;

/**
 * The other editions of the titles on one `GET /books` page, so the edition
 * picker (lib/dedupe) chooses among all of them rather than only the ones that
 * happened to land in the page's scan window.
 *
 * Without this, one-edition-per-title only holds when a title's editions sit
 * next to each other in the ordering. They do in a title sort, but not by
 * publication date or shop band: a hardback and its paperback are typically
 * published months apart, and measured on the local catalogue the page showed
 * the wrong edition for about one title in ten.
 *
 * A sibling must:
 *  - have exactly the same title (served by idx_books_title);
 *  - share a contributor with a page row of that title, compared the way
 *    fetchOtherEditions compares them — normalised, in either stored name order
 *    ("Achebe, Chinua" matches "Chinua Achebe"), generic names ignored;
 *  - pass `where`: the request's own filters, and for a search the same match
 *    the page rows had to pass (see the caller). So a filtered-out edition cannot
 *    come back in through the swap, and an author search cannot swap a book in
 *    on a co-contributor the query never named.
 *
 * Within each title the in-stock, then paperback, then hardback editions are
 * kept first, so the cap never drops the edition the picker would have chosen.
 * Each sibling comes back with its shop band, since the page's shop fields are
 * keyed on the band a row was selected by and a sibling was not selected by any.
 */
async function fetchSiblingEditions(
  pageRows: ListRow[],
  where: SQL | undefined,
): Promise<{ row: ListRow; band: ShopBand }[]> {
  if (pageRows.length === 0) return [];

  const pageIds = pageRows.map((r) => r.id);
  const titles = [...new Set(pageRows.map((r) => r.title))];
  const norm = (column: string) => sql.raw(normalisedNameSql(column));
  const notGeneric = (nameExpr: SQL) =>
    sql`upper(${nameExpr}) NOT IN (${sql.join(
      GENERIC_CONTRIBUTOR_NAMES.map((n) => sql`${n}`),
      sql`, `,
    )})`;
  // One of the sibling's names, in either stored order, equal to one of the page
  // row's names in either order.
  const sharesName = (siblingColumn: string) => sql`(
    sib_c.${sql.raw(siblingColumn)} IS NOT NULL
    AND ${notGeneric(norm(`sib_c.${siblingColumn}`))}
    AND ${norm(`sib_c.${siblingColumn}`)} IN (${norm('page_c.person_name')}, ${norm('page_c.person_name_inverted')})
  )`;

  const band = sql<number>`CASE
    WHEN ${buildShopBandCondition(SHOP_BAND.IN_STOCK)} THEN ${SHOP_BAND.IN_STOCK}
    WHEN ${buildShopBandCondition(SHOP_BAND.TO_ORDER)} THEN ${SHOP_BAND.TO_ORDER}
    ELSE ${SHOP_BAND.UNSELLABLE}
  END`;
  const format = sql`CASE upper(btrim(${books.productForm})) WHEN 'BC' THEN 0 WHEN 'BB' THEN 1 ELSE 2 END`;

  const ranked = db
    .select({
      id: books.id,
      band: band.as('sibling_band'),
      rank: sql<number>`row_number() OVER (PARTITION BY ${books.title} ORDER BY ${band}, ${format}, ${books.id})`.as(
        'sibling_rank',
      ),
    })
    .from(books)
    .where(
      and(
        inArray(books.title, titles),
        notInArray(books.id, pageIds),
        where,
        sql`EXISTS (
          SELECT 1
            FROM book_contributors sib_c
            JOIN book_contributors page_c ON page_c.book_id IN (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})
            JOIN books page_b ON page_b.id = page_c.book_id AND page_b.title = ${books.title}
           WHERE sib_c.book_id = ${books.id}
             AND (${sharesName('person_name')} OR ${sharesName('person_name_inverted')})
        )`,
      ),
    )
    .as('ranked_siblings');

  const rows = await db
    .select({ ...LIST_COLUMNS, band: ranked.band })
    .from(books)
    .innerJoin(ranked, eq(ranked.id, books.id))
    .where(lte(ranked.rank, SIBLING_EDITIONS_PER_TITLE));

  return rows.map(({ band: siblingBand, ...row }) => ({
    row: row as ListRow,
    band: Number(siblingBand) as ShopBand,
  }));
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
    // A genre is a family of stored genres now, so the slug is resolved to ids once
    // here, before the cache keys below hash opts. The slug itself is dropped: every
    // filter path reads genreIds, and keeping both would split one filter across two
    // keys whenever an old full slug and its family resolve to the same ids.
    if (opts.genre !== undefined) {
      const { genre, ...rest } = opts;
      opts = { ...rest, genreIds: await genresService.idsForSlug(genre) };
    }

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
    // v8: the edition picker now prefers in-stock, then order-in editions, then paperback > hardback > other, so v7 pages could hold the wrong edition of a title.
    const rowsCacheKey = `books:list:v8:${createHash('sha256').update(JSON.stringify(opts)).digest('hex')}`;
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
    //
    // `currency` is the one member of this list that is not page-shaped, and it is
    // removed for a different reason: it is presentation-only. It never reaches a WHERE
    // clause — the price bounds arrive from the controller already converted to GBP
    // pence (priceMinGbpPence/priceMaxGbpPence, which do stay in), so `currency` decides
    // nothing but the units the response quotes prices in. Leaving it in gave every
    // currency its own count entry for three identical numbers, and since the controller
    // resolves it from the *visitor's country*, each new country paid a fresh cold count
    // — a pair of correlated-EXISTS scans over a 2M-row catalogue, measured at 42s. It
    // has to stay in the rows key above, where the quoted prices genuinely differ.
    const {
      sort: _sort,
      sortBy: _sortBy,
      limit: _limit,
      offset: _offset,
      dedupe: _dedupe,
      cursor: _cursor,
      currency: _currency,
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
    // Pure and free: this proposes how `q` could divide into a title part and a name part,
    // and is empty for everything that cannot usefully split — a single token, or a query
    // long enough to be a full title already. An empty list is what keeps this feature off
    // the path of the searches that never needed it. v1 only: v2 makes the caller name the
    // side it wants, so a v2 search has already said the query is all title or all name.
    const splitCands = opts.q && isBlendedSearch ? splitCandidates(opts.q) : [];
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
      parseCachedCount(cachedCount).total,
    );

    type SearchTier = 'fast' | 'cheap' | 'split' | 'broad';
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
    //
    // The split band sits one rung above the fuzzy one and is entered on exactly the
    // condition that used to send a query there: the exact band matched nothing at all, by
    // title or by name. It is deliberately *not* entered when the exact band merely ran out
    // at this offset — that case keeps the behaviour it has, so a query the cheap tiers
    // answered on page 1 cannot change its mind about what it is on page 3.
    //
    // `exactBandCount === 0` stays a clean signal only because a split search never writes
    // the shared count entry (see the total below); if it did, its own total would fold back
    // in here and page 2 would read a non-empty exact band that page 1 never saw.
    const rowsTier: SearchTier = opts.q && !isAuthorSearch
      ? fastCount >= pageEnd
        ? 'fast'
        : exactBandCount > opts.offset
          ? 'cheap'
          : exactBandCount === 0 && splitCands.length > 0
            ? 'split'
            : 'broad'
      : 'broad';

    // Resolved once, ahead of both the page and the total, because they are the same list:
    // the rows are a slice of it and the count is its length. Awaiting here costs one
    // bounded, Redis-backed query on a path that was about to run the fuzzy pool instead.
    //
    // Not resolved for a shoppable listing, where the band ladder scopes each fetch to one
    // shop band and so needs a differently-filtered list per band — those are resolved inside
    // the ladder, and such a search falls back to the row floor for its caption.
    const splitIds: number[] | null =
      opts.q && rowsTier === 'split' && !opts.shoppable
        ? await resolveSplitBandIds(opts, splitCands)
        : null;

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
    const titleConditionForTier = (q: string) =>
      rowsTier === 'fast'
        ? buildFastTitlePrefixCondition(q)
        : rowsTier === 'cheap'
          ? buildTitlePrefixCondition(q)
          : buildSearchCondition(q);
    const buildRowsWhere = (o: ListBooksOptions) =>
      o.q && !isAuthorSearch ? buildWhereClause(o, titleConditionForTier(o.q)) : buildWhereClause(o);
    const rowsWhere = buildRowsWhere(opts);

    // What a sibling edition must satisfy to stand in for a page row (see
    // fetchSiblingEditions): the request's filters, minus the shop band — the band
    // is a ranking, and a sibling from another band is exactly what it may swap in
    // — plus, for a search, the match the page rows passed. A title match is safe
    // as it is, since a sibling has the identical title. A name match is not: the
    // sibling must match the query's name itself, not merely share *some*
    // contributor with a row that did, or an author search could swap in a book on
    // a co-contributor nobody searched for. The cheap name tier is used; a row that
    // only matched fuzzily simply gets no siblings, which is the safe direction.
    const siblingWhere: SQL | undefined = !opts.q
      ? buildWhereClause({ ...opts, shopBand: undefined })
      : isAuthorSearch
        ? buildWhereClause({ ...opts, shopBand: undefined }, buildAuthorMatchCondition(opts.q, 'cheap'))
        : isBlendedSearch
          ? buildWhereClause(
              { ...opts, shopBand: undefined },
              or(titleConditionForTier(opts.q), buildAuthorMatchCondition(opts.q, 'cheap')),
            )
          : buildRowsWhere({ ...opts, shopBand: undefined });

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
      // The split band is a materialised id list, not a predicate over `books`, so it has
      // no WHERE clause for countUpTo to count. buildRowsWhere would hand back the fuzzy
      // title condition here — a different and much larger set than the band actually
      // contains — and the ladder would then plan this page's offset against a boundary
      // that does not exist. Its own list, resolved for this band's filters, is the count.
      const count = rowsTier === 'split'
        ? (await resolveSplitBandIds({ ...opts, shopBand: band }, splitCands)).length
        : await countUpTo(
            buildRowsWhere({ ...opts, shopBand: band }),
            opts.q ? SEARCH_COUNT_CAP + 1 : SHOP_BAND_COUNT_CAP,
          );
      await redis.set(key, String(count), 'EX', COUNT_TTL);
      return count;
    };
    // What the search branches are told the tier is. They know three, and 'split' is not one
    // of them: it is answered above them, out of its own id list. Where it does reach them —
    // a split band that resolved empty — the right tier is 'broad', which is both what the
    // search would have used without this band and what buildRowsWhere and rowsOrderBy have
    // already built for it, since both fall through to the broad expressions for any tier
    // that is neither 'fast' nor 'cheap'.
    const branchTier: 'fast' | 'cheap' | 'broad' = rowsTier === 'split' ? 'broad' : rowsTier;
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
            // The split band, when it resolved to anything. A band that came back empty —
            // nothing matched a name and a leftover title word together — falls through to
            // the blended fuzzy page below, which is what this search would have got anyway.
            if (isBlendedSearch && rowsTier === 'split') {
              const ids = splitIds ?? (await resolveSplitBandIds(fetchOpts, splitCands));
              if (ids.length > 0) {
                return fetchSplitSearchPage({ ...fetchOpts, offset }, ids, pageSize);
              }
            }
            if (isBlendedSearch) {
              return fetchBlendedSearchPage(
                { ...fetchOpts, offset },
                fetchOpts.q,
                branchTier,
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
              branchTier,
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
                // The band sizes exist for exactly one purpose: mapping a *deep* page
                // offset onto the concatenated bands, so a page that starts past the
                // end of band 0 can skip it. At offset 0 there is nothing to skip —
                // the plan is always "first band, from the top", whatever the sizes
                // turn out to be — so the counts are bought and then not used.
                //
                // That is worth avoiding rather than tidying, because they are not
                // cheap: each is a correlated EXISTS over `gardners_stock` for every
                // candidate row, and countShopBand's LIMIT only short-circuits once a
                // band has SHOP_BAND_COUNT_CAP members — a band smaller than the cap
                // scans the whole 2M-row catalogue to discover it. Cold, the pair
                // measured at 42s and they run on the request path, so the first
                // shopper after each COUNT_TTL lapse paid for both. Offset 0 is the
                // page nearly every shopper lands on.
                //
                // The loop below is what makes skipping them safe: it already walks
                // the bands in order from `firstBand` and tops up from the next band
                // whenever one returns short, so it reaches the same rows without
                // being told where the boundaries are. That top-up is not a
                // concession to this shortcut — it is required anyway, because the
                // counts are a snapshot of a table the hourly feed writes to and only
                // the rows themselves are authoritative.
                const planned = new Map<ShopBand, number>();
                // Bands ahead of the first planned one are entirely behind this
                // offset; bands past it are fetched from the top, whether or not the
                // plan reached them.
                let firstBand: number = SHOP_BAND.IN_STOCK;
                if (effectiveOffset > 0) {
                  const [inStock, toOrder] = await Promise.all([
                    countShopBand(SHOP_BAND.IN_STOCK),
                    countShopBand(SHOP_BAND.TO_ORDER),
                  ]);
                  for (const segment of planShopBands(effectiveOffset, want, {
                    inStock,
                    toOrder,
                  })) {
                    planned.set(segment.band, segment.offset);
                  }
                  firstBand = planned.size > 0
                    ? Math.min(...planned.keys())
                    : SHOP_BAND.UNSELLABLE;
                }

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

          // With one edition per title, the picker has to see every edition of each
          // title on the page, not only those inside this scan window — see
          // fetchSiblingEditions. They only ever replace a page row of the same
          // title, never add a new position, and they do not advance the cursor:
          // pagination still runs on rawRows.
          const siblings = opts.dedupe ? await fetchSiblingEditions(rawRows, siblingWhere) : [];
          for (const sibling of siblings) bandByRow.set(sibling.row.id, sibling.band);
          const poolRows: ListRow[] = [...rawRows, ...siblings.map((sibling) => sibling.row)];

          // The shop fields are looked up for the sellable bands only. An unsellable
          // book can still have a supplier price and even stock behind it — an
          // unsuppliable report code does not erase either — and reporting them
          // would put a number on a shelf nobody can buy from and a stock badge on
          // a row with no Add button. Neither is a fact the caller can act on, and
          // both read as an offer.
          const sellableIsbns = opts.shoppable
            ? poolRows
                .filter((r) => isSellableBand(bandByRow.get(r.id) ?? SHOP_BAND.UNSELLABLE))
                .map((r) => r.isbn13)
            : [];

          const [relations, excerptMap, descriptionById, stockByIsbn, priceByIsbn] = await Promise.all([
            attachRelationsToList(poolRows),
            getExcerptsByIsbns(poolRows.map((r) => r.isbn13)),
            // Only needed for dedupe scoring — BookListItem never exposes it, and
            // fetching it for every plain page would undo the "keep payloads small"
            // reason LIST_COLUMNS leaves it out.
            opts.dedupe && poolRows.length > 0
              ? db
                  .select({ id: books.id, shortDescription: books.shortDescription })
                  .from(books)
                  .where(inArray(books.id, poolRows.map((r) => r.id)))
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
          const enriched = poolRows.map((r) => ({
            ...r,
            productFormLabel: getProductFormLabel(r.productForm),
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
            const scored = await withStockTier(
              carryOverFiltered.map((r) => ({
                ...r,
                shortDescription: descriptionById.get(r.id) ?? null,
                genreCount: r.genres.length,
                hasPrice: r.prices.length > 0,
              })),
            );
            const deduped = dedupeByTitle(scored);
            hasMore = hasMore || deduped.length > opts.limit;
            result = deduped.slice(0, opts.limit).map(({ shortDescription: _shortDescription, genreCount: _genreCount, hasPrice: _hasPrice, stockTier: _stockTier, ...item }) => item);

            if (hasMore) {
              // Resume at the first scanned row of a title this page did *not*
              // show. The window holds more distinct titles than one page, and
              // advancing past all of it used to skip every title after the
              // first `limit` for good — measured at 17 of 37 on a newest-first
              // page. Rows before that point are either shown or carried over,
              // and the returned titles ride forward in the tail, so a later
              // edition of anything shown here is filtered on the next request.
              const titleKey = (r: { title: string }) => r.title.trim().toLowerCase();
              const returnedKeys = result.map(titleKey);
              const shown = new Set(returnedKeys);
              let resumeAt = rawRows.findIndex(
                (r) => !shown.has(titleKey(r)) && !carryOverTitles.has(titleKey(r)),
              );
              // -1 means every scanned row was shown or carried over. 0 cannot
              // happen with a non-empty page — the first row's title is always
              // shown — but guarding it keeps the cursor from ever standing still.
              if (resumeAt <= 0) resumeAt = rawRows.length;
              // Oldest first, newest last, so the slice keeps the titles most
              // likely to reappear next. The old order kept the oldest and
              // dropped the newest, which let a title repeat on the very next page.
              const nextTail = Array.from(
                new Set([...(opts.cursor?.t ?? []), ...returnedKeys]),
              ).slice(-CURSOR_TAIL_TITLES);
              nextCursor = encodeDedupeCursor({
                o: effectiveOffset + resumeAt,
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
    // True when the reported total is the planner's estimate rather than a real count —
    // set either by this request computing one, or by it being served an entry that a
    // previous request stored as an estimate. Read after the await below, alongside
    // countProbeIncomplete, to decide `totalIsApproximate`.
    let totalIsEstimate = parseCachedCount(cachedCount).isEstimate;
    const totalPromise: Promise<number> = cachedCount != null
      ? Promise.resolve(parseCachedCount(cachedCount).total)
      : (async () => {
          // Stores a total that was estimated rather than counted, marked so it stays
          // approximate for everyone the entry goes on to serve.
          const cacheEstimate = async (rows: number): Promise<number> => {
            const rounded = Math.round(rows);
            totalIsEstimate = true;
            await redis.set(countCacheKey, `~${rounded}`, 'EX', COUNT_TTL);
            return rounded;
          };
          // Searches never run a count query of their own — they reuse the capped tier
          // probes computed above, so a search's count can never be the slow part again.
          if (opts.q) {
            // A split search counts itself, from the list its rows are sliced out of, and
            // deliberately does not write that number to the shared count entry. The entry
            // feeds exactBandCount on the next page, where it stands for "the cheap tiers
            // matched this much" — and the whole reason this search reached the split band
            // is that they matched nothing. Caching a split total there would make page 2
            // read a non-empty exact band, drop back to the fuzzy tier, and answer the same
            // query a different way. The list has its own entry under SPLIT_TTL, so nothing
            // is recomputed per page regardless.
            if (splitIds != null) return Math.min(splitIds.length, SEARCH_COUNT_CAP);
            const total = Math.min(searchMatchCount, SEARCH_COUNT_CAP);
            // A degraded count must not be cached for COUNT_TTL — the next request should get
            // a fresh attempt rather than inherit this lower bound for the next half hour.
            if (!countProbeIncomplete) {
              await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
            }
            return total;
          }
          // Filter-only browse (no q). An exact count is the right answer whenever it is
          // affordable, and for a selective filter it is: counting a few thousand rows off
          // an index costs nothing, and a filtered listing's pagination is exactly where a
          // real number earns its keep. The unfiltered catalogue is the other case — a 2M
          // row aggregate, measured at 5.5s cold on production, with nothing bounding it.
          //
          // A statement timeout alone is the wrong instrument for that. At 5.5s the query
          // sits right on any budget worth setting, so the timeout would fire on roughly
          // half of cold browses and only *after* having already spent the budget: the
          // slow path made slower, and the total made approximate anyway.
          //
          // So ask the planner instead of racing it. EXPLAIN without ANALYZE runs nothing
          // and answers in about a millisecond, and it yields both halves of the decision
          // — whether to count, and the number to report if not. `totalIsApproximate`
          // already exists for capped searches, and callers already paginate on `hasMore`,
          // so an estimated total is a shape clients handle rather than a new contract.
          const estimate = await estimateFilteredRows(rowsWhere);
          if (estimate != null && estimate > EXACT_COUNT_MAX_ROWS) {
            return cacheEstimate(estimate);
          }

          const countQuery = (conn: Pick<typeof db, 'select'>) =>
            conn.select({ count: sql<number>`COUNT(*)::int` }).from(books).where(rowsWhere);
          try {
            // Bounded only when there is an estimate to fall back to. If EXPLAIN itself
            // could not be read there is no second number available, and an unbounded
            // count is a better failure than a browse that 500s over its caption — so
            // that case deliberately keeps the old, unbounded behaviour.
            const [countRow] =
              estimate == null
                ? await countQuery(db)
                : await withStatementTimeout(COUNT_STATEMENT_TIMEOUT_MS, async (conn) =>
                    countQuery(conn),
                  );
            const total = countRow?.count ?? 0;
            await redis.set(countCacheKey, String(total), 'EX', COUNT_TTL);
            return total;
          } catch (err: unknown) {
            if (!isStatementTimeout(err) || estimate == null) throw err;
            // The planner called this scan small and it was not. Its estimate is the only
            // number left, and it is the one the plan was chosen on — reporting it beats
            // both failing and paying an unbounded scan to disagree.
            logger.warn('Catalogue count overran its budget — reporting the planner estimate', {
              estimate,
            });
            return cacheEstimate(estimate);
          }
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
      // The total was the planner's estimate rather than a count — see EXACT_COUNT_MAX_ROWS.
      totalIsEstimate ||
      // The floor only raises the total when the probes undercounted, which makes what we
      // report a lower bound by construction.
      total > probedTotal;
    return {
      // Attached here, after the rows cache, rather than alongside inStock inside
      // it: a quantity stepper is the one number on the card that must be live.
      books: await attachAvailableQuantity(page.rows),
      total,
      hasMore: page.hasMore,
      totalIsApproximate,
      nextCursor: page.nextCursor,
    };
  },

  async suggestions(q: string, limit: number, type: SuggestionType = 'all', dedupe = false): Promise<SuggestionItem[]> {
    // v3: results now depend on `dedupe` too (added below) — v2 entries predate the flag
    // and were always deduped, so they'd be wrongly served as the non-deduped default.
    // v4: the edition picker now prefers in-stock, then order-in editions, then paperback > hardback > other.
    const cacheKey = `suggestions:v4:${type}:${dedupe}:${createHash('sha256').update(`${q}:${limit}`).digest('hex')}`;
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

      const dedupedTitle = dedupeByTitleAndSubtitle(await withStockTier(titlePool.map(withScoring)));
      const titleIds = new Set(dedupedTitle.map((r) => r.id));
      const dedupedAuthor = dedupeByTitleAndSubtitle(await withStockTier(authorPool.map(withScoring))).filter((r) => !titleIds.has(r.id));
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

    // The dedupe path hands back its scoring rows (genreCount, hasPrice, the
    // stock-derived stockTier) typed as SuggestionRow, so they are stripped here
    // by name — otherwise they would ride into the public payload and its cache.
    type ScoredSuggestionRow = SuggestionRow & { genreCount?: number; hasPrice?: boolean; stockTier?: number };
    const results = (rows as ScoredSuggestionRow[]).map(({
      shortDescription: _shortDescription,
      availabilityCode: _availabilityCode,
      publicationDate: _publicationDate,
      genreCount: _genreCount,
      hasPrice: _hasPrice,
      stockTier: _stockTier,
      ...r
    }) => ({
      ...r,
      productFormLabel: getProductFormLabel(r.productForm),
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
          productFormLabel: getProductFormLabel(row.productForm),
          ...(relations.get(id) ?? { contributors: [], genres: [], prices: [] }),
          excerpt: pickExcerpt(row.isbn13, excerptMap),
        } as BookListItem;
      })
      .filter((book): book is BookListItem => book !== null);
  },

  /**
   * The book page. The detail itself is cached for BOOK_DETAIL_TTL;
   * `availableQuantity` is put on after the cache on every request, for the
   * same reason feeds attach their prices late — stock moves hourly.
   */
  async getById(id: number): Promise<BookDetail | null> {
    const detail = await loadBookDetail(id);
    if (!detail) return null;
    const [withQuantity] = await attachAvailableQuantity([detail]);
    // Re-applied on the way out so a detail cached before genres were shortened
    // is corrected too, without renaming the cache key that other code deletes
    // to refresh a book page. Idempotent: a shortened list comes back unchanged.
    return {
      ...withQuantity,
      genres: toDisplayGenres(withQuantity.genres),
      // An "other formats" picker needs the same live figure as the book itself.
      otherEditions: await attachAvailableQuantity(withQuantity.otherEditions),
    };
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
    // v6: the edition picker now prefers in-stock, then order-in editions, then paperback > hardback > other.
    const cacheKey = `trending:v6:${limit}`;
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
        .where(inArray(bookGenres.bookId, bookIds))
        // Fixed order so that when several genres share a display name the same
        // one's slug is kept on every read (see lib/genre-display).
        .orderBy(genres.id),

      db
        .selectDistinct({ bookId: bookPrices.bookId })
        .from(bookPrices)
        .where(inArray(bookPrices.bookId, bookIds)),
    ]);

    const excerptMap = await getExcerptsByIsbns(bookRows.map((b) => b.isbn13));

    const bookMap = new Map(
      bookRows.map((b) => [
        b.id,
        { ...b, productFormLabel: getProductFormLabel(b.productForm), contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], genreCount: 0, hasPrice: false, excerpt: pickExcerpt(b.isbn13, excerptMap) },
      ]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) {
      const entry = bookMap.get(g.bookId);
      if (entry) {
        addDisplayGenre(entry.genres, g);
        entry.genreCount++;
      }
    }
    for (const p of priceRows) {
      const entry = bookMap.get(p.bookId);
      if (entry) entry.hasPrice = true;
    }

    // Preserve the score-ordered sequence from bookIds
    const ordered = bookIds.map((id) => bookMap.get(id)).filter((b): b is FeedScoringRow => b !== undefined);
    const pool = dedupeByTitle(await withStockTier(ordered)).slice(0, cacheTarget).map(stripFeedScoring);

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
    // v4: the edition picker now prefers in-stock, then order-in editions, then paperback > hardback > other.
    const cacheKey = `personalized:v4:${userId}:${limit}`;
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
        .where(inArray(bookGenres.bookId, ids))
        // Fixed order so that when several genres share a display name the same
        // one's slug is kept on every read (see lib/genre-display).
        .orderBy(genres.id),

      db.selectDistinct({ bookId: bookPrices.bookId }).from(bookPrices).where(inArray(bookPrices.bookId, ids)),

      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    const bookMap = new Map(
      rows.map((b) => [
        b.id,
        { ...b, productFormLabel: getProductFormLabel(b.productForm), contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], genreCount: 0, hasPrice: false, excerpt: pickExcerpt(b.isbn13, excerptMap) },
      ]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) {
      const entry = bookMap.get(g.bookId);
      if (entry) {
        addDisplayGenre(entry.genres, g);
        entry.genreCount++;
      }
    }
    for (const p of priceRows) {
      const entry = bookMap.get(p.bookId);
      if (entry) entry.hasPrice = true;
    }

    // Preserve cosine similarity order from rows
    const ordered = rows.map((r) => bookMap.get(r.id)).filter((b): b is FeedScoringRow => b !== undefined);
    const results = dedupeByTitle(await withStockTier(ordered)).slice(0, limit).map(stripFeedScoring);

    // Cached without prices — attachShopFields runs on every read instead.
    await redis.set(cacheKey, JSON.stringify(results), 'EX', PERSONALIZED_TTL);
    return attachShopFields(results, currency);
  },

  /**
   * "Readers like you loved" — books the rest of your reader type has embraced.
   *
   * Where `personalized` measures the catalogue against one reader's embedding,
   * this is a straight popularity vote inside a cohort: take everyone sharing
   * the caller's `users.reader_type`, count who responded well to each book,
   * rank by that count.
   *
   * **Three things count as responding well**, not just the explicit like:
   *
   *   - `liked = true` — the deliberate signal, but liking is a Plus feature, so
   *     on its own the pool is thin enough that a smaller reader type would come
   *     back nearly empty
   *   - `status = 'read'` — they finished it
   *   - `source` of `chosen_from_onboarding` / `chosen_from_quiz` — books they
   *     named as ones they had enjoyed when the quiz asked
   *
   * A user counts **once** per book however many of the three they trip, hence
   * `count(distinct user_id)` rather than `count(*)`.
   *
   * The cohort is every matching user regardless of `shelf_visibility`. That is
   * defensible only because the output is an anonymous aggregate: this returns
   * books and nothing else — never who liked them, and not even the count.
   * **If a future change attaches names, avatars or counts to these rows, this
   * query has to start filtering on `shelf_visibility` first.** A private shelf
   * that can be reconstructed from a liker count of one is not private.
   *
   * The caller's own rows are excluded from the count, so a book only they have
   * liked can never appear — "readers like you" means other readers.
   *
   * Cohorting is on `users.reader_type` alone, which is written at signup and
   * rewritten by every quiz retake that infers a type (see lib/reader-type.ts) —
   * so a reader who retakes the quiz moves into the cohort their new picks imply,
   * and this rail follows them there without any extra lookup. The history table
   * keeps the older types for auditing; nothing here reads them.
   *
   * Returns an empty page — never an error — both when the caller has no reader
   * type and when nobody else shares theirs. To a client those are the same
   * thing: there is no rail to draw.
   *
   * Uncached, unlike the other feeds. It is offset-paginated, so the cache key
   * would carry the offset and each page would expire independently — that is
   * how a reader pages from a fresh page 1 into an hour-stale page 2 and sees a
   * book twice. The underlying aggregate is indexed and bounded by the cohort.
   */
  async likedByReaderType(
    userId: number | undefined,
    limit: number,
    offset: number,
    readerType?: ReaderType,
  ): Promise<{ books: TrendingBookItem[]; total: number }> {
    // An explicit reader type overrides the caller's own, so any cohort can be
    // browsed rather than only the one you happen to belong to. The caller is
    // still excluded from the count and their own exclusions still apply, so the
    // rows are the same rows the endpoint would ever show them — this widens
    // which cohort is read, not what may be read about it.
    //
    // Only reached with a value the controller has already checked against the
    // enum: it is interpolated into the cohort predicate, and an unvalidated
    // string would be a caller-supplied value steering the query.
    const cohortType =
      readerType ??
      (userId === undefined
        ? undefined
        : (
            await db
              .select({ readerType: users.readerType })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1)
          )[0]?.readerType);

    // No reader type, no cohort. For a signed-in reader that means onboarding
    // never ran, or Gemini failed to infer one — fetchAndInferReaderType swallows
    // that failure by design and leaves the column null rather than blocking a
    // signup over a nice-to-have. For a signed-out visitor it simply means they
    // did not name a cohort, which is the only way they can pick one.
    if (!cohortType) return { books: [], total: 0 };

    // A signed-out visitor has no shelf to exclude and no likes of their own to
    // discount, so both of those narrowings simply do not apply. They see the
    // cohort's books unfiltered — which is more than a signed-in member of the
    // same cohort sees, not less, and is the honest consequence of not knowing
    // who is asking.
    const exclusions = userId === undefined ? EMPTY_EXCLUSIONS : await getUserExclusions(userId);

    // Only a signed-in caller can be excluded from their own cohort. Rendered as
    // a fragment so the statement below has no branch in it.
    const selfFilter = userId === undefined ? sql`` : sql`AND ${users.id} <> ${userId}`;

    // Spread into the statement as ready-made fragments so the SQL below has no
    // conditional branches in it — an empty fragment renders as nothing.
    const idFilter =
      exclusions.bookIds.length > 0 ? sql`AND ${notInArray(books.id, exclusions.bookIds)}` : sql``;
    const workExclusion = buildWorkExclusionCondition(exclusions.works);
    const workFilter = workExclusion ? sql`AND ${workExclusion}` : sql``;

    // One statement rather than a count query plus a page query: `count(*) OVER ()`
    // carries the total alongside the rows, so the two cannot disagree about a
    // like that landed between them.
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT ${userBooks.userId} AS user_id, ${userBooks.bookId} AS book_id
        FROM ${userBooks}
        JOIN ${users} ON ${users.id} = ${userBooks.userId}
        WHERE ${users.readerType} = ${cohortType}
          ${selfFilter}
          AND (
            ${userBooks.liked}
            OR ${userBooks.status} = 'read'
            OR ${userBooks.source} IN ('chosen_from_onboarding', 'chosen_from_quiz')
          )
      ),
      -- One row per (catalogue row, supporter), still ungrouped: both the work
      -- score and the per-edition score below are counted off this, so they
      -- cannot be computed over different populations.
      candidates AS (
        SELECT ${books.id}              AS id,
               ${books.title}           AS title,
               ${books.subtitle}        AS subtitle,
               ${books.coverUrl}        AS cover_url,
               ${books.isbn13}          AS isbn13,
               ${books.productForm}     AS product_form,
               ${books.publicationDate} AS publication_date,
               cohort.user_id           AS user_id,
               -- The work this row is an edition of, in exactly the form
               -- lib/exclusions.ts normalises to. Identical on purpose: two
               -- spellings of "the same book" in one codebase is how a filter
               -- quietly stops matching. lower() is ASCII-only under this
               -- database's C ctype, so accented titles fold by byte rather than
               -- by locale — the same behaviour the exclusion filter already has,
               -- which is the point of copying it rather than improving on it.
               lower(btrim(${books.title})) AS work_title,
               (SELECT lower(btrim(bc.person_name))
                  FROM book_contributors bc
                 WHERE bc.book_id = ${books.id}
                   AND bc.role = 'A01'
                   AND btrim(coalesce(bc.person_name, '')) <> ''
                 ORDER BY bc.sequence_number
                 LIMIT 1) AS work_author
        FROM ${books}
        JOIN cohort ON cohort.book_id = ${books.id}
        WHERE ${buildFeedCondition()}
          AND ${buildHasAuthorCondition()}
          ${idFilter}
          ${workFilter}
      ),
      -- Support is counted per WORK, not per catalogue row. Ranking the rows and
      -- collapsing afterwards looks equivalent and is not: a book that ten people
      -- love across a paperback, a hardback and an ebook scores 4-3-3 as rows,
      -- and whichever edition survived the collapse then ranks below a book one
      -- single reader liked. Counting the work first is what makes the rail
      -- reflect what the cohort actually reads. distinct user_id because one
      -- person owning two editions is still one person.
      work_scores AS (
        SELECT work_title, work_author, COUNT(DISTINCT user_id)::int AS liker_count
        FROM candidates
        GROUP BY work_title, work_author
      ),
      -- Per-edition support, used only to decide which edition represents the
      -- work on screen: the one the cohort actually picked up.
      edition_scores AS (
        SELECT id, title, subtitle, cover_url, isbn13, product_form, publication_date,
               work_title, work_author, COUNT(DISTINCT user_id)::int AS edition_likers
        FROM candidates
        GROUP BY id, title, subtitle, cover_url, isbn13, product_form,
                 publication_date, work_title, work_author
      ),
      representative AS (
        SELECT DISTINCT ON (work_title, work_author) *
        FROM edition_scores
        ORDER BY work_title, work_author, edition_likers DESC, id
      )
      SELECT representative.id, representative.title, representative.subtitle,
             representative.cover_url, representative.isbn13,
             representative.product_form, representative.publication_date,
             work_scores.liker_count,
             COUNT(*) OVER ()::int AS total
      FROM representative
      JOIN work_scores
        ON work_scores.work_title = representative.work_title
       -- Not "=": work_author is null for an untagged catalogue row, and a plain
       -- equality drops every one of those works from the join silently.
       AND work_scores.work_author IS NOT DISTINCT FROM representative.work_author
      -- id breaks liker-count ties deterministically. Without it Postgres is free
      -- to order equally-liked works differently on each query, and offset
      -- pagination over an unstable sort silently repeats and drops rows.
      ORDER BY work_scores.liker_count DESC, representative.id
      LIMIT ${limit} OFFSET ${offset}
    `);

    // postgres-js hands back a RowList, which is array-like but not an Array —
    // same cast the other raw-SQL readers in this file use.
    const rows = result as unknown as ReaderTypeFeedRow[];
    if (rows.length === 0) return { books: [], total: 0 };

    // No price on this rail (see the docs), but the quantity is on every book
    // response, so a card here reads the same as a card anywhere else.
    return {
      books: await attachAvailableQuantity(await hydrateBookCards(rows)),
      total: Number(rows[0].total),
    };
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
    // v5: the edition picker now prefers in-stock, then order-in editions, then paperback > hardback > other.
    const cacheKey = `similar:v5:${bookId}:${limit}`;
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
        .where(inArray(bookGenres.bookId, ids))
        // Fixed order so that when several genres share a display name the same
        // one's slug is kept on every read (see lib/genre-display).
        .orderBy(genres.id),

      db.selectDistinct({ bookId: bookPrices.bookId }).from(bookPrices).where(inArray(bookPrices.bookId, ids)),

      getExcerptsByIsbns(rows.map((r) => r.isbn13)),
    ]);

    const bookMap = new Map(
      rows.map((b) => [
        b.id,
        { ...b, productFormLabel: getProductFormLabel(b.productForm), contributors: [] as TrendingBookItem['contributors'], genres: [] as TrendingBookItem['genres'], genreCount: 0, hasPrice: false, excerpt: pickExcerpt(b.isbn13, excerptMap) },
      ]),
    );
    for (const c of contributors) bookMap.get(c.bookId)?.contributors.push({ role: c.role, personName: c.personName, sequenceNumber: c.sequenceNumber });
    for (const g of genreRows) {
      const entry = bookMap.get(g.bookId);
      if (entry) {
        addDisplayGenre(entry.genres, g);
        entry.genreCount++;
      }
    }
    for (const p of priceRows) {
      const entry = bookMap.get(p.bookId);
      if (entry) entry.hasPrice = true;
    }

    // Preserve cosine similarity order from rows
    const ordered = rows.map((r) => bookMap.get(r.id)).filter((b): b is FeedScoringRow => b !== undefined);
    const pool = dedupeByTitle(await withStockTier(ordered)).slice(0, cacheTarget).map(stripFeedScoring);

    // The pool is what gets cached and shared across users; the caller gets
    // their own filtered view of it.
    await redis.set(cacheKey, JSON.stringify(pool), 'EX', PERSONALIZED_TTL);
    // Cached without prices — see attachShopFields.
    return attachShopFields(await applyUserExclusions(pool, userId, limit), currency);
  },
};

/**
 * Builds (or reads from cache) everything on the book page except the live
 * shop fields — booksService.getById is the only caller and adds those.
 */
/**
 * Copies the book's biography onto the one contributor it can be attributed
 * to, leaving every other contributor untouched. The biography also stays at
 * book level in `authorBio`, so nothing is lost when it belongs to nobody.
 */
function withAttributedBio(
  contributors: Pick<BookContributor, 'role' | 'personName' | 'sequenceNumber'>[],
  bioHtml: string | null,
): DetailContributor[] {
  const match = attributableContributor(contributors, bioHtml);
  if (!match) return contributors;

  return contributors.map((c) =>
    c === match.contributor ? { ...c, bio: { bioHtml: bioHtml!, confidence: match.confidence } } : c,
  );
}

async function loadBookDetail(id: number): Promise<BookDetail | null> {
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

  const [contributors, genreRows, priceRows, subjects, excerptMap, reviewMap, bioMap, otherEditionRows] = await Promise.all([
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
      .where(eq(bookGenres.bookId, id))
      // Fixed order so that when several genres share a display name the same
      // one's slug is kept on every read (see lib/genre-display).
      .orderBy(genres.id),

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

    getReviewsByIsbns([book.isbn13]),

    getBiosByIsbns([book.isbn13]),

    fetchOtherEditions(id, book.title),
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
    productFormLabel: getProductFormLabel(book.productForm),
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
    contributors: withAttributedBio(contributors, bioMap.get(book.isbn13 ?? '')?.bioHtml ?? null),
    genres: toDisplayGenres(genreRows),
    prices: priceRows,
    subjects,
    excerpt: pickExcerpt(book.isbn13, excerptMap),
    review: pickReview(book.isbn13, reviewMap),
    authorBio: (book.isbn13 && bioMap.get(book.isbn13)) || null,
    otherEditions: otherEditionRows.map((row) => ({
      ...row,
      productFormLabel: getProductFormLabel(row.productForm),
    })),
  };

  await redis.set(cacheKey, JSON.stringify(detail), 'EX', BOOK_DETAIL_TTL);

  // Fired after the cache is written, never awaited. A successful lookup
  // deletes this key so the next request picks the review up — doing it
  // before the set would let that delete land first and cache the
  // review-less copy for the full hour instead.
  if (!detail.review) {
    void bookReviewsService.fetchOnDemand(book.isbn13, book.id);
  }
  // One BDS lookup answers both bio and review; it checks its own ledger, so
  // a book BDS were already asked about costs one indexed read, no call.
  if (!detail.authorBio) {
    void bdsEnrichmentService.fetchOnDemand(book.isbn13, book.id);
  }

  return detail;
}

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
  const [priceByIsbn, stockByIsbn, quantityByIsbn] = await Promise.all([
    availabilityService.livePricesByIsbns(isbns),
    availabilityService.inStockByIsbns(isbns),
    availabilityService.availableQuantityByIsbns(isbns),
  ]);

  const code = SHOP_CURRENCY;

  return items.map((item): T => {
    if (!item.isbn13) return { ...item, availableQuantity: 0 };
    const live = priceByIsbn.get(item.isbn13);
    return {
      ...item,
      inStock: stockByIsbn.get(item.isbn13) ?? false,
      availableQuantity: quantityByIsbn.get(item.isbn13) ?? 0,
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

/**
 * Puts `availableQuantity` on every row — the catalogue's sibling of
 * attachShopFields, which does the same for feeds. Unconditional: a book with
 * no ISBN or no stock row gets 0 rather than no field, so a client never has to
 * guess what a missing value means.
 */
async function attachAvailableQuantity<T extends { isbn13: string | null }>(
  items: T[],
): Promise<(T & { availableQuantity: number })[]> {
  if (items.length === 0) return [];
  const quantityByIsbn = await availabilityService.availableQuantityByIsbns(
    items.map((item) => item.isbn13),
  );
  return items.map((item) => ({
    ...item,
    availableQuantity: item.isbn13 ? (quantityByIsbn.get(item.isbn13) ?? 0) : 0,
  }));
}

/**
 * Tags each row with its stock tier — on the shelf, order-in, or cannot be
 * bought (lib/shoppable's stockTierFor) — for the edition picker in lib/dedupe,
 * which ranks on it before format (paperback > hardback > other).
 */
async function withStockTier<T extends { isbn13: string | null }>(
  rows: T[],
): Promise<(T & { stockTier: StockTier })[]> {
  if (rows.length === 0) return [];
  const tierByIsbn = await availabilityService.stockTierByIsbns(rows.map((r) => r.isbn13));
  return rows.map((row) => ({
    ...row,
    stockTier: row.isbn13 ? (tierByIsbn.get(row.isbn13) ?? STOCK_TIER.UNAVAILABLE) : STOCK_TIER.UNAVAILABLE,
  }));
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
