/**
 * "Can this book be bought, by this person, shipped to there, and for how
 * much?" — the single gate every add-to-cart and checkout goes through.
 *
 * Price and stock come from `gardners_stock`, not `book_prices`. That is the
 * important choice here: `book_prices` is ONIX edition metadata, multi-currency
 * and only present for roughly half the catalogue, whereas `gardners_stock` is
 * the live wholesale feed refreshed daily (Inventory) and hourly (Avail13), and
 * is the same data our supplier will bill us against.
 *
 * `rrp_gbp` is the recommended retail price — what the customer pays.
 * `discount_percent` is the trade discount *we* receive, i.e. our margin, and
 * is deliberately never shown or applied to a customer-facing price.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  books,
  bookContributors,
  bookPromotions,
  gardnersStock,
  gardnersMarketRestrictions,
} from '../../db/schema';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { normalizeCountry } from './pricing';
// Shared with the catalogue's `shoppable` filter so browse and checkout can
// never disagree about which report codes mean "cannot be supplied".
import { UNSUPPLIABLE_REPORT_CODE_SET, isSupplyToOrder } from '../../lib/shoppable';

export type UnbuyableReason =
  | 'not_found'
  | 'no_price'
  | 'out_of_stock'
  | 'unsuppliable'
  | 'market_restricted';

export interface BuyableBook {
  bookId: number;
  isbn13: string;
  title: string;
  contributor: string | null;
  coverUrl: string | null;
  /** What the customer actually pays. The sale price when one is live. */
  unitPriceGbpPence: number;
  /**
   * The price this is marked down *from*, i.e. the RRP, and only when a
   * promotion is actually reducing it. Null means no sale — the UI must not
   * render a struck-through price, because there isn't one.
   *
   * Always strictly greater than `unitPriceGbpPence` when set: a "sale" that
   * saves nothing is a false claim, so those are dropped rather than shown.
   */
  compareAtGbpPence: number | null;
  /**
   * The supplier's real stock figure. Zero is normal and not a blocker for a
   * supply-to-order title — see `supplyToOrder`. Use `orderableQuantity` for
   * anything that caps what a customer may buy.
   */
  stockQty: number;
  /**
   * Gardners does not stock this title but will supply it to order (extended
   * catalogue, print on demand). Distinct from both "in stock" and "out of
   * stock": it is buyable, just slower. The UI should say "available to order"
   * rather than showing an out-of-stock badge.
   */
  supplyToOrder: boolean;
  /**
   * How many may actually be bought. Equal to `stockQty` for a stocked title;
   * for a supply-to-order title there is no shelf to exhaust, so it is capped
   * at the per-line maximum instead of at zero.
   */
  orderableQuantity: number;
  /**
   * What this book weighs and measures, for working out which shipping band the
   * order falls into. Carried here rather than fetched separately because every
   * caller that prices a basket has already loaded the book.
   *
   * All nullable: weight is missing for about one stocked title in fifty, and
   * thickness for rather more. See services/commerce/parcel for what happens
   * then — the short version is that an unknown is treated as the expensive
   * case, never the cheap one.
   */
  weightGr: number | null;
  heightMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  productForm: string | null;
}

export interface AvailabilityResult {
  buyable: Map<number, BuyableBook>;
  /** bookId -> why not. Only contains books that were asked about and failed. */
  rejected: Map<number, UnbuyableReason>;
}

/** `numeric` columns come back from postgres.js as strings. */
function poundsToPence(rrpGbp: string | null): number | null {
  if (rrpGbp === null) return null;
  const pounds = Number(rrpGbp);
  if (!Number.isFinite(pounds) || pounds <= 0) return null;
  return Math.round(pounds * 100);
}

/**
 * Resolves an ISO country to the Gardners region code(s) used by
 * `gardners_market_restrictions`.
 *
 * Gardners' region vocabulary is its own (REGIONS.CSV) and does not line up
 * with ISO-3166, so this mapping has to be supplied by an operator via
 * GARDNERS_REGION_BY_COUNTRY. It ships empty on purpose — a guessed mapping
 * would be worse than no mapping, because it would silently authorise sales
 * into territories we have not actually checked.
 */
function gardnersRegionsForCountry(countryCode: string): string[] {
  const mapped = config.commerce.gardnersRegionByCountry[countryCode];
  return mapped ? mapped.split('|').map((r) => r.trim().toUpperCase()).filter(Boolean) : [];
}

/**
 * Applies the market-restriction rules for one destination.
 *
 * Semantics come straight from the feed (see the schema comment):
 *   flag='Y' — the listed regions are the ONLY ones the title may be sold in.
 *   flag='N' — the listed regions are where it may NOT be sold.
 *   No rows for an ISBN at all — sellable everywhere.
 *
 * **A restricted title with an unmappable destination is blocked, not allowed.**
 * That is the one place in this file that fails closed, and it is deliberate:
 * with an open shipping-country list, the alternative is selling rights-
 * restricted titles into territories nobody has checked. Titles with no
 * restriction rows — the overwhelming majority — are unaffected.
 */
function isRestricted(
  rows: { flag: string; regionCode: string }[],
  destinationCountry: string,
  isbn13: string,
): boolean {
  if (rows.length === 0) return false;

  const regions = gardnersRegionsForCountry(destinationCountry);

  if (regions.length === 0) {
    logger.warn('Blocking a rights-restricted title: no Gardners region mapping for destination', {
      isbn13,
      destinationCountry,
      hint: 'Populate GARDNERS_REGION_BY_COUNTRY from REGIONS.CSV',
    });
    return true;
  }

  const allowlist = rows.filter((r) => r.flag === 'Y').map((r) => r.regionCode.toUpperCase());
  const denylist = rows.filter((r) => r.flag === 'N').map((r) => r.regionCode.toUpperCase());

  if (allowlist.length > 0 && !regions.some((region) => allowlist.includes(region))) {
    return true;
  }

  return regions.some((region) => denylist.includes(region));
}

export const availabilityService = {
  /**
   * Prices and availability for a set of books, for one destination.
   *
   * Batched rather than per-book because it runs on every cart read: a
   * twenty-line cart must not become twenty round trips.
   */
  async check(bookIds: number[], destinationCountry: string): Promise<AvailabilityResult> {
    const buyable = new Map<number, BuyableBook>();
    const rejected = new Map<number, UnbuyableReason>();

    if (bookIds.length === 0) return { buyable, rejected };

    const country = normalizeCountry(destinationCountry) ?? '';

    // One contributor per book for the receipt snapshot — the lowest sequence
    // number, which is the primary author in ONIX ordering.
    const primaryContributor = db
      .select({
        bookId: bookContributors.bookId,
        name: sql<string>`
          (array_agg(${bookContributors.personName}
            ORDER BY ${bookContributors.sequenceNumber} NULLS LAST))[1]
        `.as('name'),
      })
      .from(bookContributors)
      .where(inArray(bookContributors.bookId, bookIds))
      .groupBy(bookContributors.bookId)
      .as('primary_contributor');

    const rows = await db
      .select({
        bookId: books.id,
        title: books.title,
        isbn13: books.isbn13,
        coverUrl: books.coverUrl,
        isRemoved: books.isRemoved,
        weightGr: books.weightGr,
        heightMm: books.heightMm,
        widthMm: books.widthMm,
        thicknessMm: books.thicknessMm,
        productForm: books.productForm,
        contributor: primaryContributor.name,
        rrpGbp: gardnersStock.rrpGbp,
        stockQty: gardnersStock.stockQty,
        reportCode: gardnersStock.reportCode,
        // The lowest live Kinkané markdown for this book, or null. Correlated
        // subquery rather than a join so a book with two overlapping
        // promotions yields one row rather than duplicating the book — and
        // `min` makes overlapping promotions resolve in the customer's favour
        // instead of by whichever row the planner happened to return.
        salePriceGbpPence: sql<number | null>`(
          SELECT min(${bookPromotions.salePriceGbpPence})
          FROM ${bookPromotions}
          WHERE ${bookPromotions.bookId} = ${books.id}
            AND ${bookPromotions.startsAt} <= now()
            AND (${bookPromotions.endsAt} IS NULL OR ${bookPromotions.endsAt} > now())
        )`.as('sale_price_gbp_pence'),
      })
      .from(books)
      .leftJoin(primaryContributor, eq(primaryContributor.bookId, books.id))
      // Joined on isbn13, not book_id: gardners_stock.book_id is backfilled
      // after the fact and is null for any ISBN whose stock row landed before
      // the catalogue row did.
      .leftJoin(gardnersStock, eq(gardnersStock.isbn13, books.isbn13))
      .where(inArray(books.id, bookIds));

    const found = new Set(rows.map((row) => row.bookId));
    for (const bookId of bookIds) {
      if (!found.has(bookId)) rejected.set(bookId, 'not_found');
    }

    // Restriction rows for everything that got this far, in one query.
    const isbns = rows.map((row) => row.isbn13).filter((isbn): isbn is string => Boolean(isbn));

    const restrictionRows = isbns.length
      ? await db
          .select({
            isbn13: gardnersMarketRestrictions.isbn13,
            flag: gardnersMarketRestrictions.flag,
            regionCode: gardnersMarketRestrictions.regionCode,
          })
          .from(gardnersMarketRestrictions)
          .where(inArray(gardnersMarketRestrictions.isbn13, isbns))
      : [];

    const restrictionsByIsbn = new Map<string, { flag: string; regionCode: string }[]>();
    for (const row of restrictionRows) {
      const list = restrictionsByIsbn.get(row.isbn13) ?? [];
      list.push({ flag: row.flag, regionCode: row.regionCode });
      restrictionsByIsbn.set(row.isbn13, list);
    }

    for (const row of rows) {
      if (row.isRemoved || !row.isbn13) {
        rejected.set(row.bookId, 'not_found');
        continue;
      }

      const rrpGbpPence = poundsToPence(row.rrpGbp);
      if (rrpGbpPence === null) {
        rejected.set(row.bookId, 'no_price');
        continue;
      }

      // A markdown only applies if it is actually below RRP. A promotion left
      // in place after the RRP fell beneath it must not *raise* the price — the
      // customer pays the lower of the two, always.
      const salePrice = row.salePriceGbpPence === null ? null : Number(row.salePriceGbpPence);
      const onSale = salePrice !== null && Number.isFinite(salePrice) && salePrice > 0 && salePrice < rrpGbpPence;
      const unitPriceGbpPence = onSale ? salePrice : rrpGbpPence;
      const compareAtGbpPence = onSale ? rrpGbpPence : null;

      const reportCode = row.reportCode?.trim().toUpperCase();
      if (reportCode && UNSUPPLIABLE_REPORT_CODE_SET.has(reportCode)) {
        rejected.set(row.bookId, 'unsuppliable');
        continue;
      }

      // Stock is only a gate for titles Gardners actually stocks. An extended
      // catalogue or print-on-demand title legitimately reports zero and is
      // still orderable; rejecting on that blocked ~27,000 sellable books.
      const supplyToOrder = isSupplyToOrder(row.reportCode);
      const stockQty = row.stockQty ?? 0;

      if (!supplyToOrder && stockQty <= 0) {
        rejected.set(row.bookId, 'out_of_stock');
        continue;
      }

      if (isRestricted(restrictionsByIsbn.get(row.isbn13) ?? [], country, row.isbn13)) {
        rejected.set(row.bookId, 'market_restricted');
        continue;
      }

      buyable.set(row.bookId, {
        bookId: row.bookId,
        isbn13: row.isbn13,
        title: row.title,
        contributor: row.contributor ?? null,
        coverUrl: row.coverUrl ?? null,
        unitPriceGbpPence,
        compareAtGbpPence,
        stockQty,
        supplyToOrder,
        orderableQuantity: supplyToOrder ? config.commerce.cart.maxQuantityPerLine : stockQty,
        // Drizzle returns `numeric` as a string to avoid float precision loss.
        // These are millimetres and grams, where a float is fine, so they are
        // converted once here rather than at each use.
        weightGr: numericOrNull(row.weightGr),
        heightMm: numericOrNull(row.heightMm),
        widthMm: numericOrNull(row.widthMm),
        thicknessMm: numericOrNull(row.thicknessMm),
        productForm: row.productForm ?? null,
      });
    }

    return { buyable, rejected };
  },

  /**
   * Which of these ISBNs Gardners currently has stock for.
   *
   * Deliberately returns a boolean, not `stock_qty`: this feeds a public,
   * unauthenticated catalogue response, and our supplier's wholesale stock
   * levels are not ours to publish. "In stock" is all a shop badge needs.
   *
   * This is *not* a sellability check — it answers one question and skips
   * price, report code and market restrictions. Call `check()` for anything
   * that leads to a transaction.
   */
  async inStockByIsbns(isbns: (string | null)[]): Promise<Map<string, boolean>> {
    const map = new Map<string, boolean>();
    const unique = [...new Set(isbns.filter((isbn): isbn is string => isbn !== null))];
    if (unique.length === 0) return map;

    const rows = await db
      .select({ isbn13: gardnersStock.isbn13, stockQty: gardnersStock.stockQty })
      .from(gardnersStock)
      .where(inArray(gardnersStock.isbn13, unique));

    for (const row of rows) {
      map.set(row.isbn13, (row.stockQty ?? 0) > 0);
    }
    return map;
  },

  /**
   * The live sellable price for a page of ISBNs, in GBP pence.
   *
   * The sibling of inStockByIsbns, and there for the same reason: the shop's
   * listing needs it, nothing else does, and one batched query per page is
   * cheaper than putting the stock table into every search tier's plan.
   *
   * **This is the price the shop actually sells at** — `gardners_stock.rrp_gbp`,
   * with any live Kinkané markdown applied. Deliberately *not* `book_prices`,
   * which is ONIX edition metadata: the two disagree on about 2% of the
   * catalogue, and only this one matches what the cart will charge and what the
   * price filter matched on.
   *
   * `compareAtGbpPence` is the pre-markdown price when a promotion is running,
   * so a listing can strike it through, and null when there is no sale.
   */
  async livePricesByIsbns(isbns: (string | null)[]): Promise<
    Map<string, { unitPriceGbpPence: number; compareAtGbpPence: number | null }>
  > {
    const map = new Map<string, { unitPriceGbpPence: number; compareAtGbpPence: number | null }>();
    const unique = [...new Set(isbns.filter((isbn): isbn is string => isbn !== null))];
    if (unique.length === 0) return map;

    const rows = await db
      .select({
        isbn13: gardnersStock.isbn13,
        rrpGbp: gardnersStock.rrpGbp,
        // Correlated on ISBN via an IN rather than a join: joining `books`
        // inside the subquery puts a second `id` in scope and Postgres rejects
        // the reference as ambiguous.
        salePriceGbpPence: sql<number | null>`(
          SELECT min(bp.sale_price_gbp_pence)
          FROM book_promotions bp
          WHERE bp.book_id IN (
            SELECT b2.id FROM books b2 WHERE b2.isbn13 = ${gardnersStock.isbn13}
          )
            AND bp.starts_at <= now()
            AND (bp.ends_at IS NULL OR bp.ends_at > now())
        )`,
      })
      .from(gardnersStock)
      .where(inArray(gardnersStock.isbn13, unique));

    for (const row of rows) {
      if (row.rrpGbp === null) continue;
      const rrpPence = Math.round(Number(row.rrpGbp) * 100);
      const sale = row.salePriceGbpPence === null ? null : Number(row.salePriceGbpPence);
      // A "sale" at or above RRP is not a sale — same rule the cart applies, so
      // a listing cannot advertise a markdown the basket then disagrees with.
      const onSale = sale !== null && sale < rrpPence;
      map.set(row.isbn13, {
        unitPriceGbpPence: onSale ? sale! : rrpPence,
        compareAtGbpPence: onSale ? rrpPence : null,
      });
    }
    return map;
  },

  /** Single-book convenience wrapper for add-to-cart. */
  async checkOne(bookId: number, destinationCountry: string): Promise<BuyableBook | UnbuyableReason> {
    const { buyable, rejected } = await this.check([bookId], destinationCountry);
    return buyable.get(bookId) ?? rejected.get(bookId) ?? 'not_found';
  },
};

/** Maps an unbuyable reason to the HTTP status and message the API returns. */
/**
 * A `numeric` column as a number, or null when it is absent or unusable.
 *
 * Rejects zero and negatives as well as nulls: a book recorded as weighing 0g
 * is a data error, not a free postage opportunity, and letting it through would
 * quote the lightest band for a real parcel.
 */
function numericOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function unbuyableResponse(reason: UnbuyableReason): {
  statusCode: number;
  code: string;
  message: string;
} {
  switch (reason) {
    case 'not_found':
      return { statusCode: 404, code: 'BOOK_NOT_FOUND', message: 'Book not found' };
    case 'no_price':
      return {
        statusCode: 409,
        code: 'NOT_FOR_SALE',
        message: 'This book is not currently for sale',
      };
    case 'out_of_stock':
      return { statusCode: 409, code: 'OUT_OF_STOCK', message: 'This book is out of stock' };
    case 'unsuppliable':
      return {
        statusCode: 409,
        code: 'UNAVAILABLE',
        message: 'This book cannot be supplied at the moment',
      };
    case 'market_restricted':
      return {
        statusCode: 409,
        code: 'MARKET_RESTRICTED',
        message: 'This book cannot be sold in your country',
      };
  }
}
