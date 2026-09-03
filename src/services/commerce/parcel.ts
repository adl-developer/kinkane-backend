/**
 * How much a basket weighs, and what shape of parcel it goes in.
 *
 * Pure functions of their inputs, for the same reason pricing.ts is: this
 * decides which weight band an order is charged at, and getting it wrong is
 * money. Everything here is testable without a database.
 *
 * The numbers below were measured against our own catalogue rather than
 * guessed — see the note on each constant.
 */

/** What the rate table needs to know about one line of a basket. */
export interface ParcelItem {
  quantity: number;
  /** From ONIX/GARDBIB. Null for the ~2% of stocked titles that carry none. */
  weightGr: number | null;
  heightMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  /** ONIX List 150 — 'BC' paperback, 'BB' hardback, and so on. */
  productForm: string | null;
}

export interface Parcel {
  /** Despatch weight in grams, packaging included, rounded up. */
  weightG: number;
  /**
   * True when any line had no weight of its own and was estimated. Worth
   * surfacing to operators: an estimated parcel is the most likely source of a
   * gap between what we quoted and what Gardners invoice.
   */
  estimated: boolean;
  /**
   * Whether Royal Mail would treat this as a large letter rather than a parcel,
   * which in the UK is the difference between £1.91 and £2.22. False whenever
   * we cannot prove it fits — an unknown dimension quotes the dearer shape.
   */
  fitsLargeLetter: boolean;
}

/**
 * Royal Mail's large letter envelope, from the October 2025 Gardners sheet.
 * All four have to hold, and being over on any one of them makes it a parcel.
 */
const LARGE_LETTER_MAX_LENGTH_MM = 353;
const LARGE_LETTER_MAX_WIDTH_MM = 250;
const LARGE_LETTER_MAX_THICKNESS_MM = 25;
const LARGE_LETTER_MAX_WEIGHT_G = 750;

/**
 * Packaging. Gardners weigh the despatched parcel, not the book, so a 740g book
 * in a box is over the large-letter limit and priced as a parcel. Ignoring this
 * puts every book near a band boundary in the band below the one we are
 * actually invoiced for.
 *
 * Deliberately generous: a card wrap is lighter than 40g and a book box is
 * usually lighter than 120g, and over-estimating costs a few pence of margin
 * while under-estimating costs the difference between two bands.
 */
const LARGE_LETTER_PACKAGING_G = 40;
const PARCEL_PACKAGING_G = 120;

/**
 * Fallback weights for a title with none of its own, by ONIX product form.
 *
 * These are the 90th percentile of the weights we *do* have for each form
 * (measured across 73,219 books: paperbacks 788g at p90, hardbacks 1,286g,
 * everything pooled 1,300g at p95), not the median. The fallback has to err
 * heavy: quoting a band lighter than the parcel really is means paying the
 * difference ourselves on every one of them, whereas quoting a band too heavy
 * costs a little margin on about one stocked title in fifty.
 *
 * Page count was tried as a predictor and only works for paperbacks (r² 0.55);
 * for hardbacks it explains almost nothing (r² 0.11), because the boards
 * dominate. A rule that works for one form and not the other is worse than one
 * conservative constant per form.
 */
const FALLBACK_WEIGHT_BY_FORM: Record<string, number> = {
  BC: 800, // paperback
  BB: 1300, // hardback
  BH: 600, // pocket paperback
  BA: 650, // book, unspecified binding
  CB: 200, // calendar
  PC: 400, // book with audio
};
const FALLBACK_WEIGHT_G = 1300;

/** The weight of one copy, and whether it had to be guessed. */
function unitWeight(item: ParcelItem): { grams: number; estimated: boolean } {
  if (item.weightGr !== null && item.weightGr > 0) {
    return { grams: item.weightGr, estimated: false };
  }

  const form = item.productForm?.toUpperCase() ?? '';
  return { grams: FALLBACK_WEIGHT_BY_FORM[form] ?? FALLBACK_WEIGHT_G, estimated: true };
}

/**
 * Whether the whole basket would go as a large letter.
 *
 * Thickness adds up because the items are stacked; the other two dimensions do
 * not, because the envelope only has to be as long and as wide as the biggest
 * item in it. A missing dimension is disqualifying rather than ignored: we are
 * asserting the parcel fits, and an unknown does not support that assertion.
 */
function fitsLargeLetter(items: ParcelItem[], contentWeightG: number): boolean {
  if (contentWeightG + LARGE_LETTER_PACKAGING_G > LARGE_LETTER_MAX_WEIGHT_G) return false;

  let stackedThicknessMm = 0;

  for (const item of items) {
    const { heightMm, widthMm, thicknessMm } = item;
    if (heightMm === null || widthMm === null || thicknessMm === null) return false;

    // Books are catalogued height × width, but an envelope does not care which
    // way round they are — only that the larger side fits the longer limit.
    const longest = Math.max(heightMm, widthMm);
    const shortest = Math.min(heightMm, widthMm);
    if (longest > LARGE_LETTER_MAX_LENGTH_MM || shortest > LARGE_LETTER_MAX_WIDTH_MM) return false;

    stackedThicknessMm += thicknessMm * item.quantity;
    if (stackedThicknessMm > LARGE_LETTER_MAX_THICKNESS_MM) return false;
  }

  return true;
}

/**
 * Weighs a basket and decides its parcel shape.
 *
 * One parcel, always. Gardners price "per box, not per consignment" and split
 * large orders across boxes at their discretion, which we cannot predict — so a
 * genuinely heavy basket is quoted as one heavy parcel. That over-quotes a
 * split order slightly rather than under-quoting it, and the alternative is
 * inventing a packing algorithm whose output we would have no way to check.
 */
export function measureParcel(items: ParcelItem[]): Parcel {
  let contentWeightG = 0;
  let estimated = false;

  for (const item of items) {
    const unit = unitWeight(item);
    contentWeightG += unit.grams * item.quantity;
    estimated ||= unit.estimated;
  }

  const largeLetter = fitsLargeLetter(items, contentWeightG);

  return {
    weightG: Math.ceil(
      contentWeightG + (largeLetter ? LARGE_LETTER_PACKAGING_G : PARCEL_PACKAGING_G),
    ),
    estimated,
    fitsLargeLetter: largeLetter,
  };
}
