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
 *  2. **It is empty until books actually sell, and that is the correct answer.**
 *     It does not fall back to trending or to anything else. A discovery feed
 *     dressed up as a sales chart is a lie about the shop, and it would be
 *     indistinguishable to the client from a real chart. An empty list is
 *     honest and unambiguous: nothing has sold in this window yet.
 */
import { and, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { orders, orderItems, SOLD_ORDER_STATUSES } from '../../db/schema';
import { redis } from '../../lib/redis';
import { booksService } from '../books.service';

export const BESTSELLER_WINDOWS = ['7d', '30d', '90d', 'all_time'] as const;
export type BestsellerWindow = (typeof BESTSELLER_WINDOWS)[number];

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
   * Always `'orders'`. Retained because clients were told to key their section
   * heading off it, and a field disappearing is a worse break than a constant
   * one — but there is no longer any other value it can take.
   */
  source: 'orders';
  books: unknown[];
}

function cacheKey(window: BestsellerWindow, limit: number): string {
  // v2: the cached payload is a bare id array now that there is no fallback to
  // record. A v1 entry would deserialize into an object and break hydrate().
  return `bestsellers:v2:${window}:${limit}`;
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

    const rows = await db
      .select({
        bookId: orderItems.bookId,
        copiesSold: sql<number>`sum(${orderItems.quantity})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, sql`${orders.id} = ${orderItems.orderId}`)
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
   * Returns an empty list when nothing has sold in the window. That is the
   * whole contract: no substitution, no padding, no "here is something else
   * instead". A client showing a Bestsellers section should hide it when
   * `books` is empty.
   */
  async list(window: BestsellerWindow, limit: number): Promise<BestsellerResult> {
    const key = cacheKey(window, limit);
    const cached = await redis.get(key);

    if (cached) {
      return { window, source: 'orders', books: await this.hydrate(JSON.parse(cached) as number[]) };
    }

    const ranked = await this.rank(window, limit);
    const bookIds = ranked.map((item) => item.bookId);

    // Cached even when empty. A shop with no sales yet would otherwise run the
    // aggregate on every request and get nothing, forever.
    await redis.set(key, JSON.stringify(bookIds), 'EX', CACHE_TTL_SECONDS);

    return { window, source: 'orders', books: await this.hydrate(bookIds) };
  },

  /**
   * Turns ranked ids into full book payloads, preserving rank order — the
   * `IN (...)` lookup returns rows in whatever order Postgres likes.
   */
  async hydrate(bookIds: number[]): Promise<unknown[]> {
    if (bookIds.length === 0) return [];

    const books = await booksService.listByIds(bookIds);
    const byId = new Map(books.map((book) => [book.id, book]));

    return bookIds.map((id) => byId.get(id)).filter(Boolean);
  },

  /** Drops every cached window so the next request recomputes. */
  async invalidate(): Promise<void> {
    const keys = await redis.keys('bestsellers:v1:*');
    if (keys.length > 0) await redis.del(...keys);
  },
};
