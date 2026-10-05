/**
 * "Can the shop list this book at all?" — the catalogue-side filter behind
 * `GET /books?shoppable=true`, and the supplier report codes it shares with the
 * cart's sellability gate.
 *
 * This lives in lib/, apart from both services, for one reason: the code list
 * below has to be the *same* list the checkout gate enforces. Two copies would
 * drift, and the failure mode is invisible — a code added to one and not the
 * other leaves a title browsable in the shop that 409s the instant it is added
 * to a cart. One const, imported by both.
 */
import { sql, type SQL } from 'drizzle-orm';
import { books, gardnersMarketRestrictions, gardnersStock } from '../db/schema';

/**
 * Gardners report codes that mean a title cannot actually be supplied, whatever
 * the stock number says.
 *
 * NYP (not yet published), OSI (out of stock indefinitely), O/P (out of print),
 * CNC (cancelled), R/P (reprinting), POS (postponed), REF (refer to publisher).
 *
 * **GXC and M/D are deliberately absent.** They were in this list, and between
 * them they hid roughly a third of the catalogue. The I12 specification
 * (EDI_docs) settles it:
 *
 *   "Print On Demand titles (POD/MD) and Gardners Extended Catalogue titles
 *    (GXC) are never killed as these are items that we do not carry stock."
 *
 * GXC is the *extended catalogue* — titles Gardners does not stock but will
 * supply to order — and M/D is print on demand. Both are exempt from Fill/Kill
 * precisely *because* they remain orderable. They carry `stock_qty = 0`, so
 * they now surface as out of stock rather than unsellable, which is what they
 * actually are. Expect longer lead times on them than on stocked titles.
 *
 * NYP and R/P are confirmed by that same document ("the current Report, where
 * known, will be given. E.g. NYP or R/P"). The rest — OSI, O/P, CNC, POS, REF —
 * are *not* in the specification and remain inferred from codes observed in the
 * Inventory feed. None of them currently excludes a single book, so the cost of
 * being wrong about them is nil today; confirm them against Gardners' full code
 * list before that changes.
 *
 * At the checkout gate an unrecognised code fails *open* (assumed sellable), so
 * a genuinely dead code missing here surfaces as a rejected dropship line
 * rather than as a lost sale — the safer direction to err in.
 */
export const UNSUPPLIABLE_REPORT_CODES = [
  'NYP', 'OSI', 'O/P', 'OP', 'CNC', 'R/P', 'RP', 'POS', 'REF',
] as const;

export const UNSUPPLIABLE_REPORT_CODE_SET: ReadonlySet<string> = new Set(UNSUPPLIABLE_REPORT_CODES);

/**
 * Codes for titles Gardners does not stock but will supply to order.
 *
 * From the I12 specification: "Print On Demand titles (POD/MD) and Gardners
 * Extended Catalogue titles (GXC) are never killed as these are items that we
 * do not carry stock." Being exempt from Fill/Kill is precisely what makes them
 * orderable — they are the opposite of unsuppliable.
 *
 * These rows carry `stock_qty = 0`, because there genuinely is no shelf. That
 * is why they cannot be gated on stock the way a stocked title is: doing so
 * blocks roughly 27,000 sellable books at add-to-cart.
 *
 * `POD` is a plausible sibling of `M/D` given the wording above, but it has not
 * been observed in the Inventory feed and is deliberately left out — adding a
 * code here makes titles buyable, so it is the direction to be conservative in.
 */
export const SUPPLY_TO_ORDER_REPORT_CODES = ['GXC', 'M/D', 'MD'] as const;

export const SUPPLY_TO_ORDER_REPORT_CODE_SET: ReadonlySet<string> = new Set(
  SUPPLY_TO_ORDER_REPORT_CODES,
);

/** True when this report code means "not stocked, but orderable". */
export function isSupplyToOrder(reportCode: string | null | undefined): boolean {
  if (!reportCode) return false;
  return SUPPLY_TO_ORDER_REPORT_CODE_SET.has(reportCode.trim().toUpperCase());
}

/**
 * How many copies of a book one customer may put in a basket right now — the
 * `availableQuantity` every book response carries.
 *
 * Mirrors the cart's own ceiling (the add-to-cart gate in availability.service
 * plus the per-line cap in cart.service), so a quantity stepper built on this
 * number can never offer a quantity the basket then refuses:
 *
 *  - no stock row, no live price, or an unsuppliable report code → 0
 *  - supply-to-order (GXC, M/D) → the per-line cap, since there is no shelf to run out
 *  - a stocked title → its stock, capped at the per-line cap
 *
 * **Capped at the per-line maximum on purpose, not just for consistency.** The
 * raw figure is our supplier's wholesale stock, which is not ours to publish;
 * the cap means the most this ever reveals is "fewer than N left".
 *
 * Market restrictions are not applied: they depend on a destination country a
 * catalogue response does not have, and are enforced at add-to-cart instead.
 */
export function availableQuantityFor(
  stock: { rrpGbp: string | null; stockQty: number | null; reportCode: string | null } | undefined,
  maxPerLine: number,
): number {
  if (!stock) return 0;

  const rrp = stock.rrpGbp === null ? NaN : Number(stock.rrpGbp);
  if (!Number.isFinite(rrp) || rrp <= 0) return 0;

  const reportCode = stock.reportCode?.trim().toUpperCase();
  if (reportCode && UNSUPPLIABLE_REPORT_CODE_SET.has(reportCode)) return 0;

  if (isSupplyToOrder(stock.reportCode)) return maxPerLine;

  return Math.max(0, Math.min(stock.stockQty ?? 0, maxPerLine));
}

/**
 * Which stock tier an edition is in, for choosing which edition of a title to
 * show: 0 on the shelf now, 1 orderable but not stocked (extended catalogue,
 * print on demand), 2 cannot be bought at the moment. Lower is better.
 *
 * Split out from availableQuantityFor because that number cannot tell the first
 * two apart — a supply-to-order title reports the full per-line cap — and the
 * shop must not lead with an order-in hardback while the paperback is on the shelf.
 */
export const STOCK_TIER = { IN_STOCK: 0, TO_ORDER: 1, UNAVAILABLE: 2 } as const;
export type StockTier = (typeof STOCK_TIER)[keyof typeof STOCK_TIER];

export function stockTierFor(
  stock: { rrpGbp: string | null; stockQty: number | null; reportCode: string | null } | undefined,
  maxPerLine: number,
): StockTier {
  if (availableQuantityFor(stock, maxPerLine) <= 0) return STOCK_TIER.UNAVAILABLE;
  return isSupplyToOrder(stock!.reportCode) ? STOCK_TIER.TO_ORDER : STOCK_TIER.IN_STOCK;
}

/**
 * Restricts a catalogue query to books the e-commerce section can legitimately
 * list.
 *
 * **The shop's filter, and the discovery feeds'.** `GET /books?shoppable=true`
 * applies it to every query it runs — rows, total and sibling editions — and
 * then ranks what survives, see SHOP_BAND. The feeds apply it unconditionally:
 * a feed is a fixed handful of tiles that all render an Add button, so an
 * unsellable book there is a button that cannot work. buildShopBandCondition
 * is defined against this same supply test, so the two cannot disagree about
 * what sellable means.
 *
 * Three exclusions, all permanent properties of the record rather than of
 * today's stock position:
 *
 *   1. **No ISBN13.** Nothing can be ordered from Gardners without one — it is
 *      the key the entire supply chain is addressed by.
 *   2. **No price.** `rrp_gbp` on `gardners_stock`, not `book_prices`: the
 *      latter is ONIX edition metadata, multi-currency and present for roughly
 *      half the catalogue, while the former is the live wholesale feed and the
 *      figure the customer is actually charged. A book with no `gardners_stock`
 *      row at all fails here too, which is correct — we can neither price nor
 *      source it.
 *   3. **An unsuppliable report code.** Gardners telling us a title cannot be
 *      supplied outranks any stock number.
 *
 * Two things it deliberately does **not** check:
 *
 *   - **Stock.** `stock_qty` moves hourly (the Avail13 feed), so filtering on
 *     it would make books drop out of the catalogue and reappear between one
 *     page request and the next, with the 5-minute row cache freezing whichever
 *     answer it happened to observe. Out-of-stock books stay in the results
 *     carrying `inStock: false` for the shop to badge instead.
 *   - **Market restrictions.** Those are a function of the destination, and a
 *     browsing customer's country is a guess from their IP, not where the parcel
 *     is going. Excluding on it would silently hide titles a customer could
 *     legitimately order to an address elsewhere. The shop ranks restricted
 *     titles lower instead (SHOP_BAND), and rights are enforced against the real
 *     delivery country at add-to-cart — availabilityService.check().
 *
 * So this is necessary but not sufficient for a sale: everything it removes is
 * certainly unbuyable, but what survives still has to clear the full gate at
 * add-to-cart.
 */
export function buildShoppableCondition(): SQL {
  const codes = sql.join(
    UNSUPPLIABLE_REPORT_CODES.map((code) => sql`${code}`),
    sql`, `,
  );

  // Correlated EXISTS rather than a join: `gardners_stock` has a unique index on
  // isbn13, so this is one index probe per candidate row, and it cannot
  // duplicate a book the way a join would if that uniqueness ever lapsed.
  // Supported by idx_gardners_stock_shoppable, whose predicate mirrors this one.
  // The isbn13 NOT NULL test is redundant against the correlation (NULL never
  // equals anything) but lets the planner discard those rows before probing.
  return sql`(
    ${books.isbn13} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${gardnersStock} gs
      WHERE gs.isbn13 = ${books.isbn13}
        AND gs.rrp_gbp > 0
        AND (
          gs.report_code IS NULL
          OR upper(btrim(gs.report_code)) NOT IN (${codes})
        )
    )
  )`;
}

/**
 * Sellable *and* on Gardners' shelf right now: buildShoppableCondition plus
 * `stock_qty > 0`. The discovery feeds' filter — see buildFeedCondition.
 *
 * Stricter than the shop listing on purpose. `GET /books?shoppable=true` keeps
 * order-in titles (GXC, M/D, and anything out of stock today) and ranks them
 * last, because a customer searching for a specific book wants to find it even
 * if it takes longer to arrive. A feed is a handful of tiles we chose to put in
 * front of someone, and a recommendation that cannot ship this week is a poor
 * one — roughly 72% of the sellable catalogue is order-in, so without this a
 * shelf of classics can come back mostly "order in".
 *
 * The stock test is the same one the IN_STOCK band and inStockByIsbns use, so
 * every row a feed returns carries `inStock: true`. Index-only via
 * idx_gardners_stock_shoppable_stock, whose predicate matches the supply half.
 *
 * The flip side of `stock_qty` moving hourly (see buildShoppableCondition): a
 * book can drop out of a feed between requests when its last copy goes. That
 * is fine for a feed, which is not paginated and is re-ranked on every cache
 * refresh anyway.
 */
export function buildInStockCondition(): SQL {
  const codes = sql.join(
    UNSUPPLIABLE_REPORT_CODES.map((code) => sql`${code}`),
    sql`, `,
  );

  return sql`(
    ${books.isbn13} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${gardnersStock} gs
      WHERE gs.isbn13 = ${books.isbn13}
        AND gs.rrp_gbp > 0
        AND (
          gs.report_code IS NULL
          OR upper(btrim(gs.report_code)) NOT IN (${codes})
        )
        AND COALESCE(gs.stock_qty, 0) > 0
    )
  )`;
}

/**
 * Where a book sits in the shop's ordering when `GET /books?shoppable=true`.
 *
 * `shoppable=true` filters, then ranks. Anything buildShoppableCondition
 * rejects — no ISBN13, no live price, an unsuppliable report code — is not
 * listed at all; a shop that shows a book nobody can buy is showing a dead Add
 * button. What survives is emitted in four bands, in this order:
 *
 *   0 IN_STOCK            — Gardners has stock; not restricted for this customer.
 *   1 IN_STOCK_RESTRICTED — Gardners has stock; restricted for this customer.
 *   2 TO_ORDER            — `stock_qty` is 0 or null; not restricted.
 *   3 TO_ORDER_RESTRICTED — `stock_qty` is 0 or null; restricted.
 *
 * "Restricted" is judged against the customer's country when we know it and
 * restricted anywhere when we do not — see buildMarketRestrictedCondition.
 *
 * Stock is the primary key and restriction the secondary: every book on the
 * shelf comes before any book that is not, and within each the unrestricted
 * ones lead. The to-order bands are where GXC (extended catalogue) and M/D
 * (print on demand) live — genuinely orderable, just never shelved — alongside
 * titles that are merely out of stock today. See SUPPLY_TO_ORDER_REPORT_CODES.
 *
 * The bands are deliberately coarse. A finer split would be ordering on numbers
 * — a stock level, a report date — that move hourly and would reshuffle the
 * catalogue under a paginating client for no visible gain.
 *
 * UNSELLABLE is no longer a band the listing walks. It remains as the value
 * for a row that falls outside all four, so the band CASE in
 * fetchSiblingEditions has an honest ELSE and a response never labels such a
 * row sellable.
 */
export const SHOP_BAND = {
  IN_STOCK: 0,
  IN_STOCK_RESTRICTED: 1,
  TO_ORDER: 2,
  TO_ORDER_RESTRICTED: 3,
  UNSELLABLE: 4,
} as const;
export type ShopBand = (typeof SHOP_BAND)[keyof typeof SHOP_BAND];

/**
 * The bands the shop lists, in the order it lists them. UNSELLABLE is absent
 * on purpose: `shoppable=true` excludes it rather than sinking it.
 */
export const SHOP_BAND_ORDER: readonly ShopBand[] = [
  SHOP_BAND.IN_STOCK,
  SHOP_BAND.IN_STOCK_RESTRICTED,
  SHOP_BAND.TO_ORDER,
  SHOP_BAND.TO_ORDER_RESTRICTED,
];

/** True for every band a customer can put in a basket. */
export function isSellableBand(band: ShopBand): boolean {
  return band !== SHOP_BAND.UNSELLABLE;
}

/**
 * True when the book is market-restricted for a customer in the given Gardners
 * regions — or, with no regions, restricted anywhere at all.
 *
 * With regions (see gardnersRegionsForCountry) it applies exactly the rules
 * add-to-cart does in availabilityService.check():
 *
 *   - a 'N' row naming one of the customer's regions → restricted there;
 *   - 'Y' rows that name none of the customer's regions → the title is sold
 *     only elsewhere, so restricted there too;
 *   - no rows, or rows that do not touch the customer → not restricted.
 *
 * A title restricted only in the USA therefore stays at the top for a customer
 * in Ghana. Region codes are compared upper-cased, as add-to-cart does.
 *
 * With no regions — the customer's country is unknown, because the request
 * carried no geo header and MaxMind had no answer — there is nothing to test
 * against, so any restriction row counts. That errs towards ranking a book
 * lower, never towards promising one the basket may refuse.
 *
 * Wrapped as a scalar `(SELECT EXISTS (...))` rather than a bare EXISTS, and
 * that is load-bearing. A bare `NOT EXISTS` is an anti-join the planner is free
 * to rewrite, and against a table this size (~875k rows, one per restricted
 * ISBN) it does: it hashes the whole table and sorts the result, abandoning
 * the index-ordered walk that stops after one page. Measured locally on band 0,
 * page 1: 34ms before the restriction split, 714ms with a bare NOT EXISTS, 14ms
 * with this form — a scalar subquery cannot be pulled up into a join, so it
 * stays one probe of idx_gardners_market_restrictions_isbn per candidate row.
 */
export function buildMarketRestrictedCondition(regions?: readonly string[]): SQL {
  if (!regions || regions.length === 0) {
    return sql`(SELECT EXISTS (
    SELECT 1 FROM ${gardnersMarketRestrictions} mr
    WHERE mr.isbn13 = ${books.isbn13}
  ))`;
  }

  const inRegions = (column: SQL) =>
    sql`upper(${column}) IN (${sql.join(
      regions.map((region) => sql`${region.toUpperCase()}`),
      sql`, `,
    )})`;

  return sql`(SELECT EXISTS (
    SELECT 1 FROM ${gardnersMarketRestrictions} mr
    WHERE mr.isbn13 = ${books.isbn13}
      AND (
        (mr.flag = 'N' AND ${inRegions(sql`mr.region_code`)})
        OR (
          mr.flag = 'Y'
          AND NOT EXISTS (
            SELECT 1 FROM ${gardnersMarketRestrictions} mr_allow
            WHERE mr_allow.isbn13 = mr.isbn13
              AND mr_allow.flag = 'Y'
              AND ${inRegions(sql`mr_allow.region_code`)}
          )
        )
      )
  ))`;
}

/**
 * Restricts a catalogue query to one band.
 *
 * Deliberately a *predicate* rather than a `CASE` expression in `ORDER BY`,
 * which is the obvious implementation and the wrong one. The band is a
 * correlated subquery over `gardners_stock`; as a sort key it has to be
 * evaluated for every candidate row before `LIMIT` can apply, and it destroys
 * the index-ordered plan every list path here depends on — that is the same
 * shape as the title-sort regression on buildFastTitlePrefixOrderBy (70s+
 * measured on a common prefix), and the reason buildSortOrderBy still refuses
 * to offer a price sort.
 *
 * As a predicate it is the shape already proven at scale: the same correlated
 * EXISTS buildShoppableCondition filters on, backed by
 * idx_gardners_stock_shoppable. Each band keeps whatever ordering and index the
 * caller was already using, and list() walks the bands in order, mapping a page
 * offset onto them — see planShopBands.
 */
export function buildShopBandCondition(band: ShopBand, regions?: readonly string[]): SQL {
  const codes = sql.join(
    UNSUPPLIABLE_REPORT_CODES.map((code) => sql`${code}`),
    sql`, `,
  );

  // The supply half — price present and not reported unsuppliable — is exactly
  // buildShoppableCondition's EXISTS body, which is what keeps the two
  // definitions of "sellable" from drifting: UNSELLABLE is the complement of
  // the four listed bands, so a book is in one band and no other by construction.
  const suppliable = sql`
    gs.rrp_gbp > 0
    AND (
      gs.report_code IS NULL
      OR upper(btrim(gs.report_code)) NOT IN (${codes})
    )`;

  if (band === SHOP_BAND.UNSELLABLE) {
    // NOT EXISTS rather than a negated pair of the other bands: a book with no
    // ISBN13 has nothing to correlate on and must still land here, and the
    // anti-join reads that case correctly without a separate NULL test.
    return sql`(
      ${books.isbn13} IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM ${gardnersStock} gs
        WHERE gs.isbn13 = ${books.isbn13}
          AND ${suppliable}
      )
    )`;
  }

  // `stock_qty` is nullable and a null means "the feed has never said" — which
  // is not stock. COALESCE rather than `> 0` alone so the in-stock and to-order
  // bands partition the suppliable rows exhaustively; a row that satisfied
  // neither would vanish from the listing entirely.
  const inStock = band === SHOP_BAND.IN_STOCK || band === SHOP_BAND.IN_STOCK_RESTRICTED;
  const stock = inStock
    ? sql`COALESCE(gs.stock_qty, 0) > 0`
    : sql`COALESCE(gs.stock_qty, 0) = 0`;

  // EXISTS / NOT EXISTS of the same subquery, so the restricted and unrestricted
  // halves of each stock band partition it exactly.
  const restricted = band === SHOP_BAND.IN_STOCK_RESTRICTED || band === SHOP_BAND.TO_ORDER_RESTRICTED;
  const restriction = restricted
    ? buildMarketRestrictedCondition(regions)
    : sql`NOT ${buildMarketRestrictedCondition(regions)}`;

  return sql`(
    ${books.isbn13} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${gardnersStock} gs
      WHERE gs.isbn13 = ${books.isbn13}
        AND ${suppliable}
        AND ${stock}
    )
    AND ${restriction}
  )`;
}

/**
 * The price filter, as a condition of its own.
 *
 * Kept apart from buildShoppableCondition rather than folded into its EXISTS
 * so that one stays a single fixed predicate — the one idx_gardners_stock_shoppable
 * mirrors — and the bounds are added only when a customer asks for a shelf.
 *
 * `rrp_gbp` is pounds (numeric(10,2)) and the bounds arrive as pence, so the
 * comparison is done in pence to keep the arithmetic integral on our side.
 */
export function buildPriceBoundsCondition(bounds: {
  /** Inclusive lower bound, GBP pence. */
  minGbpPence?: number;
  /** Inclusive upper bound, GBP pence. */
  maxGbpPence?: number;
}): SQL | undefined {
  if (bounds.minGbpPence === undefined && bounds.maxGbpPence === undefined) return undefined;

  const floor =
    bounds.minGbpPence === undefined ? sql`` : sql` AND gs.rrp_gbp * 100 >= ${bounds.minGbpPence}`;
  const ceiling =
    bounds.maxGbpPence === undefined ? sql`` : sql` AND gs.rrp_gbp * 100 <= ${bounds.maxGbpPence}`;

  return sql`(
    ${books.isbn13} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${gardnersStock} gs
      WHERE gs.isbn13 = ${books.isbn13}
        AND gs.rrp_gbp > 0${floor}${ceiling}
    )
  )`;
}

/** One band's share of a requested page. */
export interface ShopBandSegment {
  band: ShopBand;
  /** Offset *within* the band. */
  offset: number;
  /** How many rows to take from it. */
  take: number;
}

/**
 * Maps a page of the combined listing onto the bands that make it up.
 *
 * The bands are concatenated in SHOP_BAND_ORDER, so a page is a window over
 * `band0 ++ band1 ++ band2 ++ band3` and usually falls entirely inside one of
 * them — `planShopBands(0, 20, ...)` on a healthy catalogue is a single
 * segment. Only a page straddling a boundary costs a second query.
 *
 * `bandSizes` are the counts of the leading bands of SHOP_BAND_ORDER, in that
 * order. Any band without a size — always at least the last — is treated as
 * unbounded, so the tail never needs counting: planning past its real end
 * simply fetches fewer rows, which is what ends the listing. Those counts are
 * cached (see COUNT_TTL) and may be capped, which makes a *deep* page
 * approximate in exactly the way a capped search total already is: a boundary
 * that has moved since the count was taken shifts rows by the drift, so
 * `hasMore` remains the honest pagination signal rather than arithmetic on
 * `total`. Shallow pages — every page a shopper actually reaches — are
 * unaffected, because the drift is at the boundary and the boundary is
 * thousands of rows in.
 *
 * Callers must still top up from the following band when a segment returns
 * fewer rows than it asked for: the counts and the rows are two observations of
 * a table the hourly feed is writing to, and only the rows are authoritative.
 */
export function planShopBands(
  offset: number,
  need: number,
  bandSizes: readonly number[],
): ShopBandSegment[] {
  const segments: ShopBandSegment[] = [];
  let remainingOffset = offset;
  let remaining = need;

  for (const [index, band] of SHOP_BAND_ORDER.entries()) {
    if (remaining <= 0) break;
    const size = index < SHOP_BAND_ORDER.length - 1
      ? (bandSizes[index] ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
    if (remainingOffset >= size) {
      remainingOffset -= size;
      continue;
    }
    const take = Math.min(remaining, size - remainingOffset);
    segments.push({ band, offset: remainingOffset, take });
    remaining -= take;
    remainingOffset = 0;
  }

  return segments;
}
