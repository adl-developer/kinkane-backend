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
   * ONIX List 150 product form — 'BC' paperback, 'BB' hardback — and the stock
   * tier from lib/shoppable's stockTierFor: 0 on the shelf, 1 order-in, 2 cannot
   * be bought. Optional so callers that don't rank by them (the recommendation
   * engine) keep their old ordering: two rows that both leave them out compare
   * equal on both.
   */
  productForm?: string | null;
  stockTier?: number;
}

/**
 * Which format a title is shown in first when it exists in several: hardback, then
 * paperback, then anything else (ebook, audio, board book, …). Lower wins.
 */
export function formatRank(productForm: string | null | undefined): number {
  switch (productForm?.trim().toUpperCase()) {
    case 'BB':
      return 0;
    case 'BC':
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
// title. Falls through the priority list in order — stock tier (on the shelf > order-in >
// cannot be bought), then format (hardback > paperback > other), then cover, then dataset
// completeness, then publication recency, then price — and stops at the first criterion
// that distinguishes them.
//
// Stock comes before format so a title is never led by an out-of-stock or order-in hardback
// while its paperback is on the shelf; within one tier, the hardback is the default. A full tie leaves `kept` in place, which is what makes the
// picker stable (the earlier-ranked/higher-relevance row wins ties, same as the old
// first-occurrence rule).
function isBetterEdition(candidate: DedupeCandidate, kept: DedupeCandidate): boolean {
  if (candidate.stockTier !== kept.stockTier) {
    return (candidate.stockTier ?? Infinity) < (kept.stockTier ?? Infinity);
  }

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

// How much the catalogue knows about an edition beyond its cover and price: a description,
// at least one genre, and a live availability status. Counted rather than all-or-nothing so
// an edition with two of the three still beats one with none.
function dataPoints(c: DedupeCandidate): number {
  return (
    (c.shortDescription ? 1 : 0) +
    (c.genreCount > 0 ? 1 : 0) +
    (c.availabilityCode !== null && AVAILABLE_TO_ORDER_CODES.has(c.availabilityCode) ? 1 : 0)
  );
}

// The picker for recommendation surfaces (the quiz, the feeds, "you may also like"), where a
// book is shown once and format is not a preference. After stock tier — so a recommendation
// is never led by an edition the shop cannot supply while another is on the shelf — it is:
// has a cover (a card without one reads as broken), then the newest publication date, then
// has a price, then the most data points. Rows that leave stockTier out compare equal on it.
function isBetterRecommendation(candidate: DedupeCandidate, kept: DedupeCandidate): boolean {
  if (candidate.stockTier !== kept.stockTier) {
    return (candidate.stockTier ?? Infinity) < (kept.stockTier ?? Infinity);
  }

  const candidateHasCover = candidate.coverUrl !== null;
  const keptHasCover = kept.coverUrl !== null;
  if (candidateHasCover !== keptHasCover) return candidateHasCover;

  const candidateTime = publicationTime(candidate.publicationDate);
  const keptTime = publicationTime(kept.publicationDate);
  if (candidateTime !== keptTime) return candidateTime > keptTime;

  if (candidate.hasPrice !== kept.hasPrice) return candidate.hasPrice;

  return dataPoints(candidate) > dataPoints(kept);
}

type IsBetter = (candidate: DedupeCandidate, kept: DedupeCandidate) => boolean;

function pickBestByKey<T extends DedupeCandidate>(
  rows: T[],
  keyOf: (row: T) => string,
  isBetter: IsBetter = isBetterEdition,
): T[] {
  const indexByKey = new Map<string, number>();
  const result: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(row);
    } else if (isBetter(row, result[existingIndex])) {
      result[existingIndex] = row;
    }
  }
  return result;
}

/**
 * Keeps every row but brings each work's editions together, returned as one array per work
 * so a caller can page by whole works. A group sits where its first
 * row did (so relevance ordering between works survives), and within a group the editions
 * are ordered by the same priority the one-per-title picker uses — on the shelf first, then
 * hardback > paperback > other, then cover, completeness, recency and price. For search,
 * where every edition is listed but the reader should meet the preferred one first.
 */
export function groupEditions<T extends DedupeCandidate>(rows: T[], keyOf: (row: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const byPreference = (a: T, b: T) => (isBetterEdition(a, b) ? -1 : isBetterEdition(b, a) ? 1 : 0);
  // Map iteration follows insertion order, i.e. each key's first occurrence. sort() is
  // stable, so editions that tie keep their relevance order.
  return [...groups.values()].map((group) => group.sort(byPreference));
}

/**
 * Collapses rows that share a title down to the single best edition, preserving the
 * position of each title's first occurrence (so overall relevance/rank ordering survives).
 * "Best" is decided in priority order: on the shelf > order-in > cannot be bought, then
 * hardback > paperback > any other format, then has a cover > has a complete dataset
 * (description, >=1 genre, available to order) > most recent publication date > has a
 * price. Ties keep whichever edition was already kept.
 */
export function dedupeByTitle<T extends DedupeCandidate>(rows: T[]): T[] {
  return pickBestByKey(rows, (r) => r.title.trim().toLowerCase());
}

/**
 * Folds a title or author name down to the form two listings of the same work share,
 * whatever the feed did to the spelling: case, accents, punctuation, "&" for "and", and a
 * leading or trailing article ("The Hobbit", "Hobbit, The", "hobbit") all collapse.
 *
 * Deliberately stops short of dropping subtitles. Measured on the catalogue, cutting at the
 * colon or dash merges far more distinct books than duplicates — mostly numbered series by
 * one author ("Deadly! Irish History - The Vikings" / "- The Celts") — while this folding
 * alone only ever merged true duplicates.
 *
 * In-memory only. The exclusion predicate in lib/exclusions.ts keeps its own simpler
 * normalizeForMatch, because that one has to agree with SQL and with stored snapshots.
 */
export function normalizeWorkText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .replace(/ (the|a|an)$/, '');
}

/**
 * The identity of a work for "is this the same book twice?": normalized title plus
 * normalized first author, so two editions of one book collapse while two different books
 * that happen to share a title ("Home" by two authors) stay apart. A missing author keys on
 * the title alone.
 */
export function workKey(title: string, author: string | null): string {
  // NUL separator so a title/author pair can't collide with a differently-split one.
  return `${normalizeWorkText(title)}\u0000${author ? normalizeWorkText(author) : ''}`;
}

/**
 * One edition per work for a recommendation list, keyed on {@link workKey} — the looser
 * title match plus the first author — so "Secret Lives of Baba Segi's Wives" and "The
 * Secret Lives of Baba Segi's Wives" collapse while same-titled books by different authors
 * don't. The survivor is chosen by the recommendation picker: on the shelf, then has a
 * cover, then newest, then has a price, then most data points.
 */
export function dedupeByWork<T extends DedupeCandidate & { author: string | null }>(rows: T[]): T[] {
  return pickBestByKey(rows, (r) => workKey(r.title, r.author), isBetterRecommendation);
}

/**
 * The first named A01 (author) contributor, in sequence order — the author a work is keyed
 * on. Null when the row has none.
 */
export function firstNamedAuthor(
  contributors: { role: string | null; personName: string | null; sequenceNumber?: number | null }[],
): string | null {
  const authors = contributors
    .filter((c) => c.role === 'A01' && !!c.personName?.trim())
    .sort((a, b) => (a.sequenceNumber ?? Number.MAX_SAFE_INTEGER) - (b.sequenceNumber ?? Number.MAX_SAFE_INTEGER));
  return authors[0]?.personName ?? null;
}

/**
 * {@link dedupeByWork} for card rows that carry their contributors rather than a resolved
 * author — the feeds and "you may also like".
 */
export function dedupeCardsByWork<
  T extends DedupeCandidate & {
    contributors: { role: string | null; personName: string | null; sequenceNumber?: number | null }[];
  },
>(rows: T[]): T[] {
  return pickBestByKey(rows, (r) => workKey(r.title, firstNamedAuthor(r.contributors)), isBetterRecommendation);
}

/**
 * Same as {@link dedupeByTitle}, but keyed on the title+subtitle pair so distinct books
 * that happen to share a title but differ in subtitle (e.g. different anthologies) are not
 * incorrectly collapsed into one.
 */
export function dedupeByTitleAndSubtitle<T extends DedupeCandidate>(rows: T[]): T[] {
  return pickBestByKey(rows, (r) => `${r.title.trim().toLowerCase()}|${r.subtitle?.trim().toLowerCase() ?? ''}`);
}
