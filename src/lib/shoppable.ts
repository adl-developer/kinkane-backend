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
 * CNC (cancelled), R/P (reprinting), GXC (Gardners cancelled), M/D (may be
 * discontinued), POS (postponed), REF (refer to publisher).
 *
 * Verify against Gardners' current code list before treating this as complete —
 * it was assembled from the codes observed in the Inventory feed, and at the
 * checkout gate an unrecognised code fails *open* (we assume it is sellable),
 * so a genuinely dead code missing here surfaces as a rejected dropship line
 * rather than as a lost sale.
 */
export const UNSUPPLIABLE_REPORT_CODES = [
  'NYP', 'OSI', 'O/P', 'OP', 'CNC', 'R/P', 'RP', 'GXC', 'M/D', 'MD', 'POS', 'REF',
] as const;

export const UNSUPPLIABLE_REPORT_CODE_SET: ReadonlySet<string> = new Set(UNSUPPLIABLE_REPORT_CODES);

/**
 * Restricts a catalogue query to books the e-commerce section can legitimately
 * list.
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
