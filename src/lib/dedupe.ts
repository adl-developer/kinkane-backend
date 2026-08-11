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
// title. Falls through the priority list in order — cover, then dataset completeness, then
// publication recency, then price — and stops at the first criterion that distinguishes
// them. A full tie leaves `kept` in place, which is what makes the picker stable (the
// earlier-ranked/higher-relevance row wins ties, same as the old first-occurrence rule).
function isBetterEdition(candidate: DedupeCandidate, kept: DedupeCandidate): boolean {
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
 * "Best" is decided in priority order: has a cover > has a complete dataset (description,
 * >=1 genre, available to order) > most recent publication date > has a price. Ties keep
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
