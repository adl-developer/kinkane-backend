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
import { books, gardnersStock } from '../db/schema';

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
 * Restricts a catalogue query to books the e-commerce section can legitimately
 * list.
 *
 * **The discovery feeds' filter.** `GET /books?shoppable=true` no longer uses
 * it — that endpoint ranks instead of filtering, see SHOP_BAND — but a feed is
 * a fixed handful of tiles that all render an Add button, so a feed that
 * surfaces an unsellable book produces a button that cannot work, with no
 * "further down the list" for it to sink to. Feeds still exclude; the listing
 * demotes. buildShopBandCondition is defined against this same supply test, so
 * the two cannot disagree about what sellable means.
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
 *   - **Market restrictions.** Those are a function of the destination country,
 *     and `GET /books` is public and unauthenticated — there is no destination
 *     to evaluate against. Worse, the restriction check fails *closed*: with
 *     GARDNERS_REGION_BY_COUNTRY unpopulated it treats every restricted title
 *     as blocked, which at a cart is a visible 409 but here would silently
 *     shrink the catalogue with nothing to notice it by. Rights restrictions
 *     stay enforced where a real destination exists — availabilityService.check().
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
 * Where a book sits in the shop's ordering when `GET /books?shoppable=true`.
 *
 * `shoppable` used to be a filter: anything buildShoppableCondition rejected
 * simply did not appear. It is now a *ranking* — nothing is excluded, and the
 * three bands below are emitted in order, so the shop's first page is what a
 * customer can actually buy today and the dead stock sinks to the end.
 *
 * The bands are deliberately coarse. Two values (sellable / not) would leave
 * out-of-stock titles mixed in among the buyable ones, and a finer split would
 * be ordering on numbers — a stock level, a report date — that move hourly and
 * would reshuffle the catalogue under a paginating client for no visible gain.
 *
 *   0 IN_STOCK   — clears buildShoppableCondition *and* Gardners has stock.
 *   1 TO_ORDER   — clears buildShoppableCondition, `stock_qty` is 0 or null.
 *                  This is where GXC (extended catalogue) and M/D (print on
 *                  demand) live: genuinely orderable, just never shelved, so
 *                  they are behind the stocked titles rather than below the
 *                  unsellable ones. See SUPPLY_TO_ORDER_REPORT_CODES.
 *   2 UNSELLABLE — everything else: no ISBN13, no `gardners_stock` row, no
 *                  price, or an unsuppliable report code.
 */
export const SHOP_BAND = { IN_STOCK: 0, TO_ORDER: 1, UNSELLABLE: 2 } as const;
export type ShopBand = (typeof SHOP_BAND)[keyof typeof SHOP_BAND];

/** The bands in the order the shop lists them. */
export const SHOP_BAND_ORDER: readonly ShopBand[] = [
  SHOP_BAND.IN_STOCK,
  SHOP_BAND.TO_ORDER,
  SHOP_BAND.UNSELLABLE,
];

/** True for the two bands a customer can put in a basket. */
export function isSellableBand(band: ShopBand): boolean {
  return band !== SHOP_BAND.UNSELLABLE;
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
 * EXISTS `shoppable=true` has always filtered on, backed by
 * idx_gardners_stock_shoppable. Each band keeps whatever ordering and index the
 * caller was already using, and list() walks the bands in order, mapping a page
 * offset onto them — see planShopBands.
 */
export function buildShopBandCondition(band: ShopBand): SQL {
  const codes = sql.join(
    UNSUPPLIABLE_REPORT_CODES.map((code) => sql`${code}`),
    sql`, `,
  );

  // The supply half — price present and not reported unsuppliable — is exactly
  // buildShoppableCondition's EXISTS body, which is what keeps the two
  // definitions of "sellable" from drifting: band 2 is the complement of bands
  // 0 and 1, so a book is in one band and no other by construction.
  const suppliable = sql`
    gs.rrp_gbp > 0
    AND (
      gs.report_code IS NULL
      OR upper(btrim(gs.report_code)) NOT IN (${codes})
    )`;

  if (band === SHOP_BAND.UNSELLABLE) {
    // NOT EXISTS rather than a negated band-0/1 pair: a book with no ISBN13 has
    // nothing to correlate on and must still land here, and the anti-join reads
    // that case correctly without a separate NULL test.
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
  // is not stock. COALESCE rather than `> 0` alone so the two bands partition
  // the suppliable rows exhaustively; a row that satisfied neither would vanish
  // from the listing entirely.
  const stock =
    band === SHOP_BAND.IN_STOCK
      ? sql`COALESCE(gs.stock_qty, 0) > 0`
      : sql`COALESCE(gs.stock_qty, 0) = 0`;

  return sql`(
    ${books.isbn13} IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM ${gardnersStock} gs
      WHERE gs.isbn13 = ${books.isbn13}
        AND ${suppliable}
        AND ${stock}
    )
  )`;
}

/**
 * The price filter, as a condition of its own.
 *
 * It used to ride inside buildShoppableCondition's EXISTS, which was free while
 * `shoppable` was a filter — same probe, one extra comparison. Now that
 * `shoppable` only ranks, the bounds have to stand alone, because they are
 * still a genuine *filter*: a customer asking for £5–£10 wants that shelf, not
 * the whole catalogue with the priced books on top.
 *
 * A book with no price (band 2, by definition) cannot satisfy this, so a
 * price-filtered shop page contains no unsellable rows at all — the ranking
 * simply has nothing left to sink.
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
 * The bands are concatenated, so a page is a window over
 * `band0 ++ band1 ++ band2` and usually falls entirely inside one of them —
 * `planShopBands(0, 20, ...)` on a healthy catalogue is a single segment. Only
 * a page straddling a boundary costs a second query.
 *
 * `bandSizes` are the counts of bands 0 and 1; band 2 is unbounded and always
 * last, so it never needs one. Those counts are cached (see COUNT_TTL) and may
 * be capped, which makes a *deep* page approximate in exactly the way a capped
 * search total already is: a boundary that has moved since the count was taken
 * shifts rows by the drift, so `hasMore` remains the honest pagination signal
 * rather than arithmetic on `total`. Shallow pages — every page a shopper
 * actually reaches — are unaffected, because the drift is at the boundary and
 * the boundary is tens of thousands of rows in.
 *
 * Callers must still top up from the following band when a segment returns
 * fewer rows than it asked for: the counts and the rows are two observations of
 * a table the hourly feed is writing to, and only the rows are authoritative.
 */
export function planShopBands(
  offset: number,
  need: number,
  bandSizes: { inStock: number; toOrder: number },
): ShopBandSegment[] {
  const sizes: [ShopBand, number][] = [
    [SHOP_BAND.IN_STOCK, bandSizes.inStock],
    [SHOP_BAND.TO_ORDER, bandSizes.toOrder],
    [SHOP_BAND.UNSELLABLE, Number.POSITIVE_INFINITY],
  ];

  const segments: ShopBandSegment[] = [];
  let remainingOffset = offset;
  let remaining = need;

  for (const [band, size] of sizes) {
    if (remaining <= 0) break;
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
