/**
 * The bestseller chart.
 *
 * **Gardners does not supply this.** All eight of its feeds are inventory or
 * bibliographic — price, stock, availability, promotions, firm sale, ISBN
 * slips, market restrictions, covers. None carries a sales rank or a units-sold
 * figure. `gardners_promotions` is the closest thing and is deliberately not
 * used here: promotional titles are publisher marketing spend, not sales
 * performance, and presenting them as a bestseller list would be a lie.
 *
 * So the ranking is built from our own `order_items`, which has two
 * consequences worth stating plainly:
 *
 *  1. **It counts copies, never money.** Summing revenue would rank a book
 *     differently depending on which currency its buyers happened to be in.
 *  2. **When nothing has sold in the window it falls back to trending.** This
 *     was deliberately not done for a long time, and the objection was a real
 *     one: a discovery feed rendered under a Bestsellers heading is a lie about
 *     the shop. The fallback is therefore *labelled*, never silent — `source`
 *     says `'trending'` whenever it fires, and a client that presents the two
 *     identically is choosing to. Read `source` before you write the heading.
 */
import { and, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { books, orders, orderItems, SOLD_ORDER_STATUSES } from '../../db/schema';
import { redis } from '../../lib/redis';
import { attachShopFields, booksService, buildFeedCondition } from '../books.service';
import type { BookListItem } from '../books.service';

export const BESTSELLER_WINDOWS = ['7d', '30d', '90d', 'all_time'] as const;
export type BestsellerWindow = (typeof BESTSELLER_WINDOWS)[number];

/** Whether a given response is a real sales chart or the trending fallback. */
export type BestsellerSource = 'orders' | 'trending';

const WINDOW_DAYS: Record<BestsellerWindow, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all_time: null,
};

const CACHE_TTL_SECONDS = 60 * 60;

export interface BestsellerItem {
  bookId: number;
  copiesSold: number;
  rank: number;
}

export interface BestsellerResult {
  window: BestsellerWindow;
  /**
   * Where the list actually came from. `'orders'` is a genuine sales ranking;
   * `'trending'` means nothing sold in this window and the books below are a
   * discovery feed, ranked by interaction signal rather than by copies bought.
   * Key the section heading off this — the two are not the same claim.
   */
  source: BestsellerSource;
  books: BookListItem[];
}

function cacheKey(window: BestsellerWindow, limit: number): string {
  // v4: the chart now skips books the shop cannot sell whether or not the
  // caller passed `shoppable` (see buildFeedCondition), so both callers want
  // the same list — `shoppable` is out of the key again, and the bump drops
  // the pre-fix `:all` entries that still hold unsellable ids. (v3 keyed on
  // shoppable, because the two charts really were different lists then; v2 was
  // a bare id array with no shoppable dimension; v1 an object that would
  // deserialize into hydrate() and break it.)
  //
  // Ids only. The price is attached per request, so a supplier price change
  // shows immediately while the ordering may be up to an hour old — which is
  // what the endpoint documents.
  //
  // Only the orders ranking is cached here, and a cached empty array means
  // "nothing sold in this window" — the trending fallback is resolved after the
  // cache read, so it keeps its own freshness instead of being frozen for an
  // hour behind a bestsellers key.
  return `bestsellers:v4:${window}:${limit}`;
}

export const bestsellersService = {
  /**
   * Ranked book ids and copy counts for a window. Uncached — `list` is the
   * caller-facing entry point.
   */
  async rank(window: BestsellerWindow, limit: number): Promise<BestsellerItem[]> {
    const days = WINDOW_DAYS[window];

    const conditions = [inArray(orders.status, SOLD_ORDER_STATUSES)];
    if (days !== null) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      conditions.push(gte(orders.createdAt, since));
    }

    // Joined so the feed predicate can be applied in the ranking query itself.
    // Filtering after the `limit` would be the bug feedPoolMultiplier exists to
    // work around elsewhere — a top 10 arriving with three rows in it — and
    // there is no need for a pool here: the condition is in the same statement,
    // so `limit` sellable books come back as `limit` sellable books.
    conditions.push(buildFeedCondition());

    const rows = await db
      .select({
        bookId: orderItems.bookId,
        copiesSold: sql<number>`sum(${orderItems.quantity})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, sql`${orders.id} = ${orderItems.orderId}`)
      .innerJoin(books, sql`${books.id} = ${orderItems.bookId}`)
      .where(and(...conditions))
      .groupBy(orderItems.bookId)
      // Tie-break on book id so equal-selling books hold a stable order between
      // requests instead of shuffling on every cache refresh.
      .orderBy(sql`sum(${orderItems.quantity}) DESC, ${orderItems.bookId} ASC`)
      .limit(limit);

    return rows.map((row, index) => ({
      bookId: row.bookId,
      copiesSold: row.copiesSold,
      rank: index + 1,
    }));
  },

  /**
   * The chart as the client should render it, cached for an hour.
   *
   * When nothing has sold in the window this returns trending books with
   * `source: 'trending'` rather than an empty list. The substitution is only
   * defensible because it is declared: a caller that renders both under the
   * same heading is presenting a discovery feed as a sales chart. Read
   * `source`.
   *
   * `books` can still come back empty — a shop with neither sales nor
   * interactions has nothing to show either way.
   *
   * Books the shop cannot sell never appear — a bestseller rail is precisely
   * where an unsellable book produces an Add button that cannot work — and every
   * row carries the live price and stock. Neither is a flag the caller passes;
   * see buildFeedCondition.
   */
  async list(
    window: BestsellerWindow,
    limit: number,
    currency?: string,
  ): Promise<BestsellerResult> {
    const key = cacheKey(window, limit);
    const cached = await redis.get(key);

    let bookIds: number[];
    if (cached) {
      bookIds = JSON.parse(cached) as number[];
    } else {
      bookIds = (await this.rank(window, limit)).map((item) => item.bookId);

      // Cached even when empty. A shop with no sales yet would otherwise run
      // the aggregate on every request and get nothing, forever — and would
      // reach the fallback by the slowest possible route.
      await redis.set(key, JSON.stringify(bookIds), 'EX', CACHE_TTL_SECONDS);
    }

    if (bookIds.length > 0) {
      // Prices go on here rather than in hydrate(), so the shop fields ride the
      // same code path as every other feed's.
      return {
        window,
        source: 'orders',
        books: await attachShopFields(await this.hydrate(bookIds), currency),
      };
    }

    // No userId: a bestseller response is the same for every caller, and the
    // fallback keeps that property rather than quietly becoming personalised the
    // moment the shop runs dry. booksService.trending holds its own cache, so
    // this is not a second uncached aggregate. No currency either — these rows
    // are re-hydrated and priced below, so pricing them here would be wasted
    // work thrown away by the hydrate.
    const trending = await booksService.trending(limit, undefined);

    // Re-hydrated through the same path as the orders ranking rather than
    // returned as-is. `trending` yields the narrower TrendingBookItem, and one
    // endpoint that returns two different book shapes depending on whether the
    // shop happened to sell anything is a trap: a client renders this rail with
    // one card component, and it would lose publisher, imprint and the rest the
    // moment the fallback engaged. Costs one lookup on a path that only runs
    // when the chart is empty.
    return {
      window,
      source: 'trending',
      books: await attachShopFields(
        await this.hydrate(trending.map((book) => book.id)),
        currency,
      ),
    };
  },

  /**
   * Turns ranked ids into full book payloads, preserving rank order — the
   * `IN (...)` lookup returns rows in whatever order Postgres likes.
   */
  async hydrate(bookIds: number[]): Promise<BookListItem[]> {
    if (bookIds.length === 0) return [];

    const rows = await booksService.listByIds(bookIds);
    const byId = new Map(rows.map((book) => [book.id, book]));

    return bookIds
      .map((id) => byId.get(id))
      .filter((book): book is BookListItem => book !== undefined);
  },

  /**
   * Drops every cached window so the next request recomputes.
   *
   * Matches on the unversioned prefix deliberately: this scanned `v1` while
   * cacheKey() wrote `v2`, so it silently cleared nothing and every window ran
   * to its full hour regardless of the nightly job. Sweeping all versions also
   * cleans up stragglers the next time the payload shape changes.
   */
  async invalidate(): Promise<void> {
    const keys = await redis.keys('bestsellers:*');
    if (keys.length > 0) await redis.del(...keys);
  },
};
