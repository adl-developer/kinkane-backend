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
  gardnersStock,
  gardnersMarketRestrictions,
} from '../../db/schema';
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { normalizeCountry } from './pricing';

/**
 * Gardners report codes that mean a title cannot actually be supplied, whatever
 * the stock number says.
 *
 * NYP (not yet published), OSI (out of stock indefinitely), O/P (out of print),
 * CNC (cancelled), R/P (reprinting), GXC (Gardners cancelled), M/D (may be
 * discontinued), POS (postponed), REF (refer to publisher).
 *
 * Verify against Gardners' current code list before treating this as complete —
 * it was assembled from the codes observed in the Inventory feed, and an
 * unrecognised code fails *open* (we assume it is sellable), so a genuinely
 * dead code that is missing here will surface as a rejected dropship line
 * rather than as a lost sale.
 */
const UNSUPPLIABLE_REPORT_CODES = new Set([
  'NYP', 'OSI', 'O/P', 'OP', 'CNC', 'R/P', 'RP', 'GXC', 'M/D', 'MD', 'POS', 'REF',
]);

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
  unitPriceGbpPence: number;
  stockQty: number;
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
        contributor: primaryContributor.name,
        rrpGbp: gardnersStock.rrpGbp,
        stockQty: gardnersStock.stockQty,
        reportCode: gardnersStock.reportCode,
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

      const unitPriceGbpPence = poundsToPence(row.rrpGbp);
      if (unitPriceGbpPence === null) {
        rejected.set(row.bookId, 'no_price');
        continue;
      }

      const reportCode = row.reportCode?.trim().toUpperCase();
      if (reportCode && UNSUPPLIABLE_REPORT_CODES.has(reportCode)) {
        rejected.set(row.bookId, 'unsuppliable');
        continue;
      }

      if ((row.stockQty ?? 0) <= 0) {
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
        stockQty: row.stockQty ?? 0,
      });
    }

    return { buyable, rejected };
  },

  /** Single-book convenience wrapper for add-to-cart. */
  async checkOne(bookId: number, destinationCountry: string): Promise<BuyableBook | UnbuyableReason> {
    const { buyable, rejected } = await this.check([bookId], destinationCountry);
    return buyable.get(bookId) ?? rejected.get(bookId) ?? 'not_found';
  },
};

/** Maps an unbuyable reason to the HTTP status and message the API returns. */
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
