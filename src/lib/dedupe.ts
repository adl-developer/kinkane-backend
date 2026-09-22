// ONIX List 65 codes treated as "available to order" for the completeness check below:
// 20 Available, 21 In stock, 22 To order, 23 Available subject to reprint. Everything else
// (not yet available, no longer available, out of stock indefinitely, etc.) counts as not
// available.
const AVAILABLE_TO_ORDER_CODES = new Set(['20', '21', '22', '23']);

export interface DedupeCandidate {
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  shortDescription: string | null;
  genreCount: number;
  availabilityCode: string | null;
  publicationDate: string | null;
  hasPrice: boolean;
  /**
   * ONIX List 150 product form — 'BC' paperback, 'BB' hardback — and whether the
   * edition can be bought right now (availableQuantity > 0). Optional so callers
   * that don't rank by them (the recommendation engine) keep their old ordering:
   * two rows that both leave them out compare equal on both.
   */
  productForm?: string | null;
  buyable?: boolean;
}

/**
 * Which format a title is shown in when it exists in several: paperback, then
 * hardback, then anything else (ebook, audio, board book, …). Lower wins.
 */
export function formatRank(productForm: string | null | undefined): number {
  switch (productForm?.trim().toUpperCase()) {
    case 'BC':
      return 0;
    case 'BB':
      return 1;
    default:
      return 2;
  }
}

function isComplete(c: DedupeCandidate): boolean {
  return (
    !!c.shortDescription &&
    c.genreCount > 0 &&
    c.availabilityCode !== null &&
    AVAILABLE_TO_ORDER_CODES.has(c.availabilityCode)
  );
}

// Unparseable/missing dates sort last, so a dated edition always beats an undated one.
function publicationTime(date: string | null): number {
  if (!date) return -Infinity;
  const t = Date.parse(date);
  return Number.isNaN(t) ? -Infinity : t;
}

// True if `candidate` should replace `kept` as the representative edition for their shared
// title. Falls through the priority list in order — buyable now, then format (paperback >
// hardback > other), then cover, then dataset completeness, then publication recency, then
// price — and stops at the first criterion that distinguishes them.
//
// Buyable comes before format so a title is never shown as an out-of-stock paperback when
// its hardback is on the shelf; among editions that can (or can't) be bought alike, the
// paperback is the default. A full tie leaves `kept` in place, which is what makes the
// picker stable (the earlier-ranked/higher-relevance row wins ties, same as the old
// first-occurrence rule).
function isBetterEdition(candidate: DedupeCandidate, kept: DedupeCandidate): boolean {
  if (candidate.buyable !== kept.buyable) return candidate.buyable === true;

  const candidateFormat = formatRank(candidate.productForm);
  const keptFormat = formatRank(kept.productForm);
  if (candidateFormat !== keptFormat) return candidateFormat < keptFormat;

  const candidateHasCover = candidate.coverUrl !== null;
  const keptHasCover = kept.coverUrl !== null;
  if (candidateHasCover !== keptHasCover) return candidateHasCover;

  const candidateComplete = isComplete(candidate);
  const keptComplete = isComplete(kept);
  if (candidateComplete !== keptComplete) return candidateComplete;

  const candidateTime = publicationTime(candidate.publicationDate);
  const keptTime = publicationTime(kept.publicationDate);
  if (candidateTime !== keptTime) return candidateTime > keptTime;

  if (candidate.hasPrice !== kept.hasPrice) return candidate.hasPrice;

  return false;
}

function pickBestByKey<T extends DedupeCandidate>(rows: T[], keyOf: (row: T) => string): T[] {
  const indexByKey = new Map<string, number>();
  const result: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(row);
    } else if (isBetterEdition(row, result[existingIndex])) {
      result[existingIndex] = row;
    }
  }
  return result;
}

/**
 * Collapses rows that share a title down to the single best edition, preserving the
 * position of each title's first occurrence (so overall relevance/rank ordering survives).
 * "Best" is decided in priority order: buyable now > paperback > hardback > any other
 * format > has a cover > has a complete dataset (description, >=1 genre, available to
 * order) > most recent publication date > has a price. Ties keep
 * whichever edition was already kept.
 */
export function dedupeByTitle<T extends DedupeCandidate>(rows: T[]): T[] {
  return pickBestByKey(rows, (r) => r.title.trim().toLowerCase());
}

/**
 * Same as {@link dedupeByTitle}, but keyed on the title+subtitle pair so distinct books
 * that happen to share a title but differ in subtitle (e.g. different anthologies) are not
 * incorrectly collapsed into one.
 */
export function dedupeByTitleAndSubtitle<T extends DedupeCandidate>(rows: T[]): T[] {
  return pickBestByKey(rows, (r) => `${r.title.trim().toLowerCase()}|${r.subtitle?.trim().toLowerCase() ?? ''}`);
}
