import { createHash } from 'crypto';
import { eq, sql, and, inArray, notInArray, gt, desc, isNotNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  books,
  bookContributors,
  bookGenres,
  bookPrices,
  genres,
  userBooks,
  userInteractions,
  userPreferences,
  users,
  type ReaderType,
} from '../db/schema';
import { recommendationCache, type RecommendationItem } from '../db/schema/recommendations';
import type { Dislikes } from '../db/schema/onboarding';
import { dedupeByWork, workKey } from '../lib/dedupe';
import { buildFeedCondition } from './books.service';
import { isStatementTimeout, withStatementTimeout, TRENDING_WINDOW_DAYS } from './books.service';
import { TRENDING_SCORED_TYPES, trendingScoreSql } from './interactions.service';
import {
  buildHasAuthorCondition,
  buildWorkExclusionCondition,
  bustPersonalizedFeedCache,
  bustUserExclusions,
  getUserExclusions,
  normalizeForMatch,
  EMPTY_EXCLUSIONS,
  WORK_MATCH_VERSION,
  type ExcludedWork,
  type UserExclusions,
} from '../lib/exclusions';
import { quizPickShelfRows } from '../lib/quiz-picks';
import {
  generateEmbedding,
  generateEmbeddings,
  generateExplanations,
  NAME_PLACEHOLDER,
  type BookContext,
} from '../lib/gemini';
import { averageUnitVectors, combineWeightedVectors, type WeightedLane } from '../lib/vector';
import { config } from '../config';
import { fetchAndInferReaderType } from '../lib/reader-type';
import { guestService } from './guest.service';
import { dislikedBooksService } from './disliked-books.service';
import { preferenceHistoryService } from './preference-history.service';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';

// The four values below are environment-overridable (RECO_TARGET_RESULTS,
// RECO_FETCH_POOL, RECO_SIMILARITY_MAX, RECO_BACKFILL_MAX). Their defaults and
// the bounds they are validated against live in config/index.ts; the reasoning
// for each stays here, next to the code that depends on it.
// How many results we aim to return to the client. Kept well below the old
// 250 because each result gets its own synchronous Gemini explanation call —
// fewer results means fewer explanation chunks and a faster response.
const TARGET_RESULTS = config.recommendations.targetResults;
// How large a pool the single candidate pass fetches. It covers both tiers —
// the pool divides itself, since a preference set with few strict matches
// simply spends more of the pool on backfill. Larger than TARGET_RESULTS so
// title dedup still tends to leave us with 100.
//
// Was 1000, which is free headroom only under a brute-force mental model. With
// the iterative index scan below the LIMIT is what the scan works towards, so
// the pool size is paid for in latency: measured against the live catalogue,
// 300 rows come back in ~800ms and 1000 in ~5-18s.
const FETCH_POOL = config.recommendations.fetchPool;
// Cosine distance upper bound — books further than this from the preference
// vector are excluded. Lower = stricter (0 = identical, 1 = orthogonal).
const SIMILARITY_THRESHOLD = config.recommendations.similarityMax;
// For narrow/niche preference combinations, fewer than TARGET_RESULTS books
// fall within SIMILARITY_THRESHOLD out of 1M+ in the catalogue. Rather than
// return a short list, the remainder is filled from the next-nearest books —
// first the backfill band out to this cutoff, then the reach band beyond it.
// Both are always ranked after every strict match (see fetchCandidateBooks).
//
// This is a boundary drawn in memory, not a predicate on the query. It used to
// be the query's outer bound, and that was what made short lists possible: a
// reader whose vector had fewer than TARGET_RESULTS books inside it got fewer
// than TARGET_RESULTS back. It was also the slow version of the sparse case —
// when too few rows qualify, the iterative scan grinds on to
// hnsw.max_scan_tuples looking for more. Without the bound the scan stops as
// soon as it has FETCH_POOL rows that pass the filters.
//
// Nor is any band ever asked for on its own. A `distance >= x` predicate reads
// naturally but is the worst thing to ask an HNSW index: the scan walks outward
// from the nearest neighbour, so it rejects every row visited first. Measured
// on an 83k-row catalogue that cost 2753ms against 739ms without the floor.
const BACKFILL_SIMILARITY_THRESHOLD = config.recommendations.backfillMax;
// The pool a short list re-reads the vector search with, when a full FETCH_POOL
// page still collapsed below TARGET_RESULTS works (heavy multi-edition titles).
// One wider pass from the top rather than paging on with OFFSET: a page under an
// index scan re-walks every row before it, so pages 2 and 3 would cost 600 + 900
// rows on top of the first 300, across separate transactions that can disagree
// about which rows qualify. 500 is RECO_FETCH_POOL's ceiling in config/index.ts —
// the largest pool reviewed as affordable — so the wide pass stays inside it.
const WIDE_FETCH_POOL = 500;
// Each genre fallback batch over-fetches by this factor so collapsing editions
// into works usually leaves enough to fill the list in one batch. When it does
// not, further batches are read until the list is full or the catalogue runs out.
const GENRE_FALLBACK_HEADROOM = 4;
// The whole genre fallback, every batch together, must finish inside this. It
// runs exactly when the filters are at their most restrictive, ordered
// newest-first across the whole catalogue, so on a large catalogue a batch can
// walk a long way before finding enough rows. A list a few books short is a
// better outcome than a quiz that hangs — this is the one way a list can come
// back short while the catalogue still holds books that pass the reader's rules.
const GENRE_FALLBACK_BUDGET_MS = 3000;
// The filler, the very last tier, over-fetches by the same factor and for the
// same reason. It has no time budget — it is what makes the list reach
// TARGET_RESULTS — so its batches are capped in number instead, as a guard
// against a loop that never makes progress rather than a limit expected to bind.
const FILLER_MAX_BATCHES = 10;
// The <=> searches below run against the HNSW index, which visits roughly
// `ef_search` graph nodes and then stops — every condition in baseConditions
// (sellability, format intent, dislikes, the user's exclusions) is applied to
// whatever that scan handed back, not pushed into it. At the default ef_search
// of 40, a query asking for FETCH_POOL rows hands the filter 40 candidates and
// keeps the handful that survive. Measured against the live catalogue (1.1M
// embedded books): the strict pass returned 0-6 rows of a requested 1000. That
// is the single-book response.
//
// The real fix is the iterative scan, which resumes the search when the filter
// has eaten a batch rather than giving up — so ef_search only needs to size the
// first batch. strict_order, not relaxed_order, because `rank` is the position
// in cosine order and has to stay exact.
const HNSW_EF_SEARCH = 50;
const HNSW_ITERATIVE_SCAN = 'strict_order';
// Iterative scan landed in pgvector 0.8.0. Below that there is no resuming, so
// the only lever is a single wide pass — 1000 is the ceiling this GUC accepts.
const HNSW_EF_SEARCH_NO_ITERATIVE = 1000;
// How many index tuples the iterative scan may visit before it gives up and
// returns what it has. pgvector's default is 20,000. The scan stops at FETCH_POOL
// rows that pass the filters, so this only matters when the filters reject most
// of what the scan visits — and they reject a lot: only ~26% of embedded books
// are in stock, before format, dislikes and the reader's exclusions. At the
// default a heavily filtered search could stop short of FETCH_POOL rows and hand
// back a short list. Not measured against production; the rows a normal search
// visits are far below either number, so only the sparse case pays for it.
const HNSW_MAX_SCAN_TUPLES = 100_000;
// The scan has a second stop: once the candidates it is holding outgrow
// work_mem x this multiplier (default 1). At a 4MB work_mem that cap can arrive
// before HNSW_MAX_SCAN_TUPLES does, which would make the raise above do nothing,
// so the memory allowance is raised with it. Scoped to the transaction like the
// rest, and bounded: 4 x work_mem for one query, only on the sparse path.
const HNSW_SCAN_MEM_MULTIPLIER = 4;
const MIN_ITERATIVE_SCAN_VERSION = [0, 8, 0];
// What the settings above were before they became environment-overridable.
// Used only to recognise an untouched environment (see retrievalFingerprint):
// matching these means the search behaves exactly as it did, so cached entries
// written by the previous release are still correct and worth keeping.
// RECO_BACKFILL_MAX is not among them: it no longer changes which books are
// returned, only how the top-up is labelled in the logs, so changing it must
// not flush the cache.
const BASELINE_SIMILARITY_MAX = 0.5;
const BASELINE_TARGET_RESULTS = 50;

const CACHE_TTL_HOURS = 48;
// A list below TARGET_RESULTS is either a catalogue that genuinely has nothing
// more for these answers or a genre fallback that ran out of time, and from here
// the two are indistinguishable. Caching either one for the full 48 hours means
// every reader with those answers is served the same short list until it
// expires, so short lists get a much shorter lease and re-run sooner. The rate
// limiter (20/hour) bounds the cost. This used to apply only below 10 books,
// when lists were routinely short; now that a full list is the norm, any
// shortfall is the exception worth retrying.
const SHORT_RESULT_CACHE_TTL_HOURS = 1;
// v2 — explanations now carry the reader-name token (see NAME_PLACEHOLDER).
// v3 — explanations must address the reader in second person, so entries
//      written under v2 (which allowed "Elisabeth will love this") are retired.
const EXPLANATION_PROMPT_VERSION = 3;
// v1 — lists are filled to TARGET_RESULTS (no distance bound, extra vector
//      pages, genre fallback). Entries written before it can be short and were
//      cached for 48 hours if they held 10 or more books.
const CANDIDATE_FILL_VERSION = 1;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecommendationInput {
  displayName: string;
  feelings: string[];
  bookIds: number[];
  genres: string[];
  dislikes: Dislikes;
  /**
   * Every book the user has ever swiped away, accumulated across onboarding
   * and all later quizzes. Read-only on this type: it is populated on the way
   * out (getPreferences, refresh) from the append-only dislikes table, and
   * ignored on the way in. Recording a new rejection goes through
   * recommendationsService.saveSelections, the only write path for a logged-in
   * user; a guest's swipes go on the guest session instead (see
   * guestService.saveSelections).
   */
  dislikedBookIds?: number[];
}

/**
 * Flattens the dislikes object into a single list of labels. Every consumer
 * below treats dislikes as a flat set — the category keys exist for the UI's
 * grouping, not for anything the recommendation pipeline reasons about.
 */
function flattenDislikes(dislikes: Dislikes): string[] {
  return Object.values(dislikes ?? {}).flatMap((v) => (Array.isArray(v) ? v : []));
}

export interface RecommendationResult {
  recommendations: RecommendationItem[];
  guestSessionId: string;
  expiresAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Produces a stable SHA-256 hash of the input by sorting all arrays first,
 * so the same preferences in a different order hit the same cache entry.
 */
// displayName is intentionally excluded — it's identity, not preference.
// Two users with the same tastes but different names get the same cached recommendations.
function hashInput(input: RecommendationInput, dislikedBookIds: number[] = []): string {
  const normalized = {
    // Not a preference — a cache-buster. The explanation prompt changes what
    // the stored text *is* (v2 introduced the reader-name token), so entries
    // written by an older prompt have to be retired rather than served for the
    // rest of their 48-hour TTL. Bump this whenever a prompt change alters the
    // shape of what gets cached, not merely its wording.
    promptVersion: EXPLANATION_PROMPT_VERSION,
    // Also not a preference. The field weights and distance cutoffs come from
    // the environment now, and changing either produces a different result set
    // from identical answers — so they have to retire cached entries the same
    // way a prompt change does. Without this, tuning a weight would appear to
    // do nothing for up to 48 hours.
    retrieval: retrievalFingerprint(),
    // Also not a preference: how the list is filled out once the close matches
    // run out. A change there retires entries that were cached short.
    fill: CANDIDATE_FILL_VERSION,
    // Also not a preference: which books count as "the one you already read"
    // decides what is filtered out, so a change to that rule retires entries.
    workMatch: WORK_MATCH_VERSION,
    feelings: [...input.feelings].sort(),
    bookIds: [...input.bookIds].sort((a, b) => a - b),
    genres: [...input.genres].sort(),
    // Part of the key because it changes the result set: two users with
    // identical quiz answers but different rejection histories must not share
    // a cache entry, or one of them gets back books they swiped away.
    dislikedBookIds: [...dislikedBookIds].sort((a, b) => a - b),
    // Categories are open, so the hash is built from the flat sorted label set.
    // That also makes the cache key indifferent to which category a label was
    // filed under — if the UI moves "slow paced" from one group to another, the
    // preferences are still the same preferences.
    dislikes: flattenDislikes(input.dislikes).sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * The name as it should read inside a sentence: the first whitespace-separated
 * token of whatever the reader gave us. "Elisabeth Mensah" addresses as
 * "Elisabeth", because "Elisabeth Mensah, you wanted something meaningful"
 * reads like a form letter.
 *
 * Length-capped because displayName accepts up to 100 characters and every one
 * of them would land inside a 250-character explanation.
 */
export function toFirstName(displayName: string | null | undefined): string {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.slice(0, MAX_NAME_LENGTH);
}

/**
 * Swaps the name token in cached explanation text for this reader's actual
 * name. Runs on every read path — including cache hits, which is the whole
 * point: the stored text is shared between readers and only becomes personal
 * here.
 *
 * Deliberately not re-truncated to 250 characters afterwards. The model is
 * told to budget for the name, so the substituted string lands close to the
 * cap either way, and slicing here would cut a real sentence mid-word — a
 * worse outcome than a card running a few characters long.
 *
 * With no usable name, the token is removed rather than left visible: a
 * literal "{{name}}" on a recommendation card is the one failure mode worth
 * engineering against. A leading "{{name}}, " is dropped whole and the
 * sentence re-capitalised, so it degrades to a clean impersonal explanation.
 */
export function personalizeExplanations(
  items: RecommendationItem[],
  displayName: string | null | undefined,
): RecommendationItem[] {
  const name = toFirstName(displayName);

  return items.map((item) => ({
    ...item,
    explanation: applyReaderName(item.explanation, name),
  }));
}

function applyReaderName(explanation: string, name: string): string {
  if (!explanation.includes(NAME_PLACEHOLDER)) return explanation;

  if (name) {
    return explanation.split(NAME_PLACEHOLDER).join(name);
  }

  // No name to insert. Strip the token along with the punctuation that was
  // only there to attach it to the sentence.
  const stripped = explanation
    .split(`${NAME_PLACEHOLDER}, `)
    .join('')
    .split(`, ${NAME_PLACEHOLDER}`)
    .join('')
    .split(NAME_PLACEHOLDER)
    .join('')
    .trim();

  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Long enough for any real first name, short enough not to eat the card. */
const MAX_NAME_LENGTH = 40;

/**
 * A book the reader named as "Just Right".
 *
 * `embedding` is the book's own ingest-time vector, which is what the books
 * lane searches on when RECO_BOOKS_FROM_EMBEDDINGS is enabled. Null for a book
 * the embedding backfill has not reached — see buildPreferenceLanes for what
 * happens then.
 */
export interface LikedBook {
  id: number;
  title: string;
  authors: string[];
  embedding?: number[] | null;
}

/** Fetches the title, primary authors and stored embedding for books the user says they've enjoyed. */
async function fetchLikedBooks(bookIds: number[]): Promise<LikedBook[]> {
  if (bookIds.length === 0) return [];

  // Run both queries in parallel — they have no dependency on each other
  const [rows, contributors] = await Promise.all([
    db
      .select({ id: books.id, title: books.title, embedding: books.embedding })
      .from(books)
      .where(inArray(books.id, bookIds)),
    db
      .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
      .from(bookContributors)
      .where(
        and(
          inArray(bookContributors.bookId, bookIds),
          eq(bookContributors.role, 'A01'),
        ),
      )
      .orderBy(bookContributors.sequenceNumber),
  ]);

  if (rows.length === 0) return [];

  const authorMap = new Map<number, string[]>();
  for (const c of contributors) {
    if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
    if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    authors: authorMap.get(r.id) ?? [],
    embedding: r.embedding,
  }));
}

/**
 * Turns the books a user named in the quiz into work-level exclusions — one
 * per author, so an edition that credits only the second author of a
 * co-written book still matches. A book with no author recorded becomes a
 * title-only exclusion.
 */
function likedBooksToWorks(
  likedBooks: { title: string; authors: string[] }[],
): ExcludedWork[] {
  return likedBooks.flatMap((b): ExcludedWork[] => {
    const title = normalizeForMatch(b.title);
    const authors = b.authors.filter((a) => a.trim());
    return authors.length > 0
      ? authors.map((a) => ({ title, author: normalizeForMatch(a) }))
      : [{ title, author: null }];
  });
}

/**
 * The full WHERE set shared by both entry points: dislike filters, format
 * intent, a named-author requirement, and everything the user has told us not
 * to show them — the books they said they've already read, plus every book
 * they've ever swiped away.
 *
 * The work-level exclusion is applied here, in SQL, rather than by filtering
 * the result array afterwards. Post-filtering would silently return a short
 * list; a WHERE clause lets the search top itself back up to TARGET_RESULTS.
 */
export function buildBaseConditions(
  input: { genres: string[]; bookIds: number[]; dislikes: Dislikes },
  likedBooks: { title: string; authors: string[] }[],
  exclusions: UserExclusions,
): SQL[] {
  const formatCondition = buildFormatCondition(resolveFormatIntent(input.genres));

  return [
    // The rules no tier ever relaxes, the filler included — see
    // buildFillerConditions.
    ...buildFillerConditions(input, likedBooks, exclusions),
    ...buildDislikeConditions(input.dislikes),
    ...(formatCondition ? [formatCondition] : []),
  ];
}

/**
 * The rules that hold even for the filler that pads a list to TARGET_RESULTS
 * when everything else has run out. The reader's taste — format and dislikes —
 * gives way there; these do not:
 *
 *   - sellable and in stock. Withdrawn and unsellable titles never reach a
 *     recommendation list. The quiz is the first thing a new reader sees and
 *     every card on it is a book we are inviting them to buy, so a title the
 *     shop cannot sell is worse here than anywhere else — there is no "further
 *     down the page" for it to sink to. Same predicate as every discovery feed,
 *     imported rather than restated so the two cannot drift apart on what
 *     sellable means.
 *   - has a named author, which every card and the work dedupe rely on.
 *   - never a book the reader named, shelved or swiped away, nor another
 *     edition of one. The quiz promises not to show a book twice.
 */
export function buildFillerConditions(
  input: { bookIds: number[] },
  likedBooks: { title: string; authors: string[] }[],
  exclusions: UserExclusions,
): SQL[] {
  // Exact-ID exclusion stays alongside the work-level one: it's indexed and
  // cheap, and it covers the case where the same work is stored under a title
  // spelling that doesn't normalize identically.
  const excludedIds = [...new Set([...input.bookIds, ...exclusions.bookIds])];
  const workCondition = buildWorkExclusionCondition([
    ...likedBooksToWorks(likedBooks),
    ...exclusions.works,
  ]);

  return [
    buildFeedCondition(),
    buildHasAuthorCondition(),
    ...(excludedIds.length > 0 ? [notInArray(books.id, excludedIds)] : []),
    ...(workCondition ? [workCondition] : []),
  ];
}

/**
 * Converts the structured user input into a single natural-language paragraph
 * that gets embedded by gemini-embedding — richer text produces a better vector.
 */
export function buildPreferenceText(
  input: { feelings: string[]; genres: string[]; dislikes: Dislikes },
  likedBooks: { id: number; title: string; authors: string[] }[],
): string {
  const parts: string[] = [];

  parts.push(`I want to feel: ${input.feelings.join(', ')}.`);
  parts.push(`Preferred genres: ${input.genres.join(', ')}.`);

  if (likedBooks.length > 0) {
    const titles = likedBooks
      .map((b) =>
        b.authors.length ? `"${b.title}" by ${b.authors.join(', ')}` : `"${b.title}"`,
      )
      .join('; ');
    parts.push(`Books I have enjoyed: ${titles}.`);
  }

  const allDislikes = flattenDislikes(input.dislikes);

  if (allDislikes.length > 0) {
    parts.push(`I want to avoid: ${allDislikes.join(', ')}.`);
  }

  return parts.join(' ');
}

// ── Weighted preference vector ────────────────────────────────────────────────

/**
 * The preference fields that get their own embedding, in the order they are
 * combined. `tags` is wired up but inert until the quiz collects reader tags —
 * its weight defaults to 0, so it costs nothing in the meantime.
 */
export interface PreferenceFields {
  feelings: string[];
  genres: string[];
  dislikes: Dislikes;
  tags?: string[];
}

/**
 * The centre of the books a reader named, in the same space the catalogue is
 * searched in.
 *
 * This is what the doc calls a semantic fingerprint, and it is cheaper than it
 * sounds: each book's vector already encodes its subjects and its description,
 * so averaging them asks "what do these books have in common" without a single
 * call to Gemini. The old lane embedded the titles, which asked a much weaker
 * question — whether the model happened to recognise the names.
 *
 * Books still waiting on the embedding backfill are skipped rather than
 * blocking the lane; a reader who named five books of which three are embedded
 * gets a fingerprint of those three. Returns null when none of them are, and
 * the caller falls back to the titles.
 */
function likedBooksCentroid(likedBooks: LikedBook[]): number[] | null {
  const embedded = likedBooks.filter(
    (b): b is LikedBook & { embedding: number[] } => Array.isArray(b.embedding),
  );

  if (embedded.length === 0) {
    logger.warn('No liked book has an embedding yet, falling back to the titles lane', {
      bookIds: likedBooks.map((b) => b.id),
    });
    return null;
  }

  if (embedded.length < likedBooks.length) {
    logger.info('Some liked books are not embedded yet and are absent from the fingerprint', {
      used: embedded.length,
      named: likedBooks.length,
      missing: likedBooks.filter((b) => !Array.isArray(b.embedding)).map((b) => b.id),
    });
  }

  const centroid = averageUnitVectors(embedded.map((b) => b.embedding));
  if (!centroid) {
    // Only reachable if the stored vectors cancel out or are degenerate —
    // not something the catalogue should produce, so it is worth hearing about.
    logger.warn('Liked book embeddings produced no usable direction', {
      bookIds: embedded.map((b) => b.id),
    });
  }

  return centroid;
}

/**
 * One lane of the weighted preference vector.
 *
 * Most lanes describe the reader in words and are embedded on the way past.
 * The books lane can instead arrive with its vector already built, from the
 * stored embeddings of the books themselves — nothing needs embedding because
 * the catalogue did it at ingest.
 */
type PreferenceLane = { field: string; weight: number; sign: 1 | -1 } & (
  | { text: string; vector?: undefined }
  | { vector: number[]; text?: undefined }
);

/**
 * One natural-language clause per preference field, each embedded separately.
 *
 * This is the whole mechanism behind configurable weights. `buildPreferenceText`
 * still exists and is still the right thing to send to the explanation model —
 * it reads as a person describing their taste. But as *one* embedding it gave
 * every field an accidental weight: whatever share of the paragraph its text
 * happened to occupy. Five liked books carry full titles and author names and
 * took roughly two thirds of the signal; feelings took a tenth. Splitting the
 * clauses lets `config.recommendations.weights` decide instead.
 *
 * Empty fields produce no lane, so a reader who named no books is not searched
 * against an empty-string embedding.
 */
function buildPreferenceLanes(input: PreferenceFields, likedBooks: LikedBook[]): PreferenceLane[] {
  const weights = config.recommendations.weights;
  const lanes: PreferenceLane[] = [];

  if (input.feelings.length > 0) {
    lanes.push({
      field: 'feelings',
      text: `I want to feel: ${input.feelings.join(', ')}.`,
      weight: weights.feelings,
      sign: 1,
    });
  }

  if (input.genres.length > 0) {
    // "Preferred genres: romance, crime." reads like a sentence out of a
    // genre-studies paper, and that is what it found: measured against the
    // catalogue it returned Phraseology and Style in Subgenres of the Novel
    // and Cross-Cultural Perspectives on Gangs — literary criticism and
    // criminology, not novels.
    //
    // A bare subject list has the same problem, because a scholarly work's
    // subject headings look exactly like it. What fixes it is anchoring the
    // list to a book someone would read: the same words plus "A book to read."
    // returned The Da Vinci Code, The Godfather and Beach Read, at 0.277
    // instead of 0.341.
    //
    // Deliberately not "Fiction." — it scores a hair better on fiction genres
    // (0.276) but the vocabulary also carries business, politics, travel and
    // biography, where it pulls towards academic monographs. The neutral
    // anchor is within 0.001 on fiction and clearly better on the rest.
    lanes.push({
      field: 'genres',
      text: `${input.genres.join(', ')}. A book to read.`,
      weight: weights.genres,
      sign: 1,
    });
  }

  if (likedBooks.length > 0) {
    const centroid = config.recommendations.booksFromEmbeddings
      ? likedBooksCentroid(likedBooks)
      : null;

    if (centroid) {
      lanes.push({ field: 'books', vector: centroid, weight: weights.books, sign: 1 });
    } else {
      // Either the switch is off, or not one of the named books has been
      // embedded yet. Naming the titles is weak, but it is the signal that
      // shipped and it is better than dropping the reader's books from their
      // own search.
      const titles = likedBooks
        .map((b) => (b.authors.length ? `"${b.title}" by ${b.authors.join(', ')}` : `"${b.title}"`))
        .join('; ');
      lanes.push({
        field: 'books',
        text: `Books I have enjoyed: ${titles}.`,
        weight: weights.books,
        sign: 1,
      });
    }
  }

  if (input.tags?.length) {
    lanes.push({
      field: 'tags',
      text: `Themes and tags I am looking for: ${input.tags.join(', ')}.`,
      weight: weights.tags,
      sign: 1,
    });
  }

  const allDislikes = flattenDislikes(input.dislikes);
  if (allDislikes.length > 0) {
    // Phrased as a plain description of the thing, not as an avoidance — the
    // minus sign carries the "away from" and the words should carry only the
    // subject. "I want to avoid gore" embeds close to "gore" either way, so
    // saying it positively and subtracting the lane is the honest version of
    // what the maths is doing.
    lanes.push({
      field: 'dislikes',
      text: `Books about: ${allDislikes.join(', ')}.`,
      weight: weights.dislikes,
      sign: -1,
    });
  }

  return lanes;
}

/**
 * A fingerprint of everything that changes what a search returns without
 * changing the reader's answers.
 *
 * Results are cached for 48 hours against a hash of the preferences, so a
 * weight or threshold change would otherwise be invisible until every existing
 * entry expired — the classic "I tuned it and nothing happened" failure. Same
 * role `promptVersion` plays for the explanation text.
 */
function retrievalFingerprint(): string | undefined {
  const { weightingEnabled, booksFromEmbeddings, weights, similarityMax, targetResults } =
    config.recommendations;

  // An environment that has touched none of this gets no fingerprint at all,
  // not a fingerprint of the defaults. JSON.stringify drops an undefined value,
  // so the cache key stays byte-identical to the one this pipeline produced
  // before weighting existed and a deploy keeps its warm cache instead of
  // recomputing 48 hours of entries for no behavioural difference.
  const isBaseline =
    !weightingEnabled &&
    !booksFromEmbeddings &&
    similarityMax === BASELINE_SIMILARITY_MAX &&
    targetResults === BASELINE_TARGET_RESULTS;

  if (isBaseline) return undefined;

  return [
    weightingEnabled ? 'w' : 'legacy',
    // The books lane searches on a different vector under this flag, so an
    // entry written with it off is a different search, not a stale one.
    booksFromEmbeddings ? 'bvec' : 'btitle',
    weights.feelings,
    weights.genres,
    weights.books,
    weights.dislikes,
    weights.tags,
    similarityMax,
    targetResults,
  ].join(':');
}

/**
 * Embeds each preference field separately and combines them under the
 * configured weights (see lib/vector.ts for the maths).
 *
 * Falls back to embedding the whole paragraph as one vector when the weighted
 * combination cannot produce a direction — every weight set to 0, or lanes
 * that cancel out. That is a misconfiguration rather than a user error, and a
 * reader asking for recommendations should still get recommendations while
 * somebody fixes the environment.
 */
export async function generatePreferenceVector(
  input: PreferenceFields,
  likedBooks: LikedBook[],
): Promise<number[]> {
  // Switched off: build the vector the way the pipeline always did, from one
  // embedding of the combined paragraph. Not equivalent to setting every weight
  // to 100 — a centroid of four separately embedded fields points somewhere
  // slightly different from one embedding of the same words joined up.
  if (!config.recommendations.weightingEnabled) {
    return generateEmbedding(buildPreferenceText(input, likedBooks));
  }

  const lanes = buildPreferenceLanes(input, likedBooks);
  // Weight 0 means the field is not part of the search at all, so it never
  // reaches Gemini — turning a field off makes the request cheaper, not
  // marginally quieter.
  const active = lanes.filter((lane) => lane.weight > 0);

  if (active.length > 0) {
    // Only the lanes that are still words cost an embedding call. A books lane
    // built from stored vectors is already in the right space, so on that path
    // the request to Gemini gets shorter rather than longer.
    const textLanes = active.filter((lane) => lane.text !== undefined);
    const embedded = textLanes.length
      ? await generateEmbeddings(textLanes.map((lane) => lane.text!))
      : [];
    const byField = new Map(textLanes.map((lane, i) => [lane.field, embedded[i]]));

    const weighted: WeightedLane[] = active.map((lane) => ({
      field: lane.field,
      vector: lane.vector ?? byField.get(lane.field)!,
      weight: lane.weight,
      sign: lane.sign,
    }));

    const combined = combineWeightedVectors(weighted);
    if (combined) return combined;

    logger.warn('Weighted preference lanes produced no usable direction, falling back', {
      lanes: active.map((l) => `${l.field}:${l.sign > 0 ? '+' : '-'}${l.weight}`),
    });
  } else {
    logger.warn('Every preference lane is disabled or empty, falling back to combined text', {
      weights: config.recommendations.weights,
    });
  }

  return generateEmbedding(buildPreferenceText(input, likedBooks));
}

/**
 * Builds SQL WHERE conditions from the dislikes that have a hard column match.
 *
 * - "long book (500+ pages)"  → page_count < 500 (NULLs are kept — unknown length is fine)
 * - "series commitment"       → approximate: exclude titles/subtitles that contain
 *                               common series numbering patterns like "#1", "Book 2", "Vol. 3".
 *                               Not exhaustive, but catches the vast majority of explicit series.
 *
 * These two labels are the only ones with a hard filter; every other dislike
 * influences the result through the preference embedding alone. Because the
 * categories are open, the labels are matched anywhere in the object rather than
 * under a specific key — if the UI regroups them the filters keep working. Note
 * this is an exact-string match: reword either label in the frontend and the
 * corresponding filter silently stops applying.
 */
function buildDislikeConditions(dislikes: Dislikes) {
  const conditions = [];
  const labels = flattenDislikes(dislikes);

  if (labels.includes('long book (500+ pages)')) {
    conditions.push(
      sql`(${books.pageCount} IS NULL OR ${books.pageCount} < 500)`,
    );
  }

  if (labels.includes('series commitment')) {
    conditions.push(
      sql`NOT (
        ${books.title} ~* '\\s#[0-9]'
        OR ${books.title} ~* '\\sbook\\s[0-9]'
        OR ${books.title} ~* '\\svolume\\s[0-9]'
        OR ${books.title} ~* '\\svol\\.?\\s[0-9]'
        OR ${books.title} ~* '\\spart\\s[0-9]'
        OR COALESCE(${books.subtitle}, '') ~* 'book\\s[0-9]'
        OR COALESCE(${books.subtitle}, '') ~* 'volume\\s[0-9]'
        OR COALESCE(${books.subtitle}, '') ~* 'vol\\.?\\s[0-9]'
        OR COALESCE(${books.subtitle}, '') ~* 'part\\s[0-9]'
      )`,
    );
  }

  return conditions;
}

// Every genre option exposed at onboarding, in one place: which side of the
// fiction / non-fiction line it sits on, and which Thema subject-code prefixes it
// stands for. The controller accepts any label, so unknown ones are simply left
// out of both uses.
//
// `side` drives the format filter. pgvector similarity alone doesn't enforce
// format — a self-help book can embed close enough to "escapism, romance" to
// show up in the candidate pool — so this backs the similarity search with an
// explicit format constraint. 'poetry' is deliberately left without a side: it
// spans both shelving conventions and shouldn't force a format filter.
//
// `subjects` is used only by the genre fallback, the last resort when the vector
// search cannot fill the list. 'non-fiction' has none — it is a side, not a genre.
const QUIZ_GENRES: Record<string, { side: 'fiction' | 'non-fiction' | null; subjects: string[] }> = {
  'literary fiction': { side: 'fiction', subjects: ['FB'] },
  mystery: { side: 'fiction', subjects: ['FF'] },
  romance: { side: 'fiction', subjects: ['FR'] },
  horror: { side: 'fiction', subjects: ['FK'] },
  'sci-fi': { side: 'fiction', subjects: ['FL'] },
  'historical fiction': { side: 'fiction', subjects: ['FV'] },
  fantasy: { side: 'fiction', subjects: ['FM'] },
  crime: { side: 'fiction', subjects: ['FF', 'FH'] },
  'young adult': { side: 'fiction', subjects: ['YF'] },
  classics: { side: 'fiction', subjects: ['FBC'] },
  'graphic novel': { side: 'fiction', subjects: ['X'] },
  'self-help': { side: 'non-fiction', subjects: ['VS'] },
  business: { side: 'non-fiction', subjects: ['K'] },
  biography: { side: 'non-fiction', subjects: ['DNB', 'DNC'] },
  'non-fiction': { side: 'non-fiction', subjects: [] },
  'society & education': { side: 'non-fiction', subjects: ['JB', 'JH', 'JN'] },
  sport: { side: 'non-fiction', subjects: ['S'] },
  politics: { side: 'non-fiction', subjects: ['JP'] },
  'health & lifestyle': { side: 'non-fiction', subjects: ['VF', 'WJ'] },
  travel: { side: 'non-fiction', subjects: ['WT'] },
  poetry: { side: null, subjects: ['DC'] },
};

function quizGenre(label: string) {
  return QUIZ_GENRES[label.trim().toLowerCase()];
}

/**
 * Returns 'fiction' or 'non-fiction' only when every genre the user picked
 * falls unambiguously on one side. A mixed selection (or one made up entirely
 * of unbucketed genres like poetry) returns null, meaning "don't filter by
 * format" rather than guessing at intent.
 */
function resolveFormatIntent(genreSelections: string[]): 'fiction' | 'non-fiction' | null {
  const sides = new Set(
    genreSelections
      .map((g) => quizGenre(g)?.side ?? null)
      .filter((side): side is 'fiction' | 'non-fiction' => side !== null),
  );
  return sides.size === 1 ? [...sides][0] : null;
}

/**
 * Excludes books confidently tagged as the wrong format, while leaving
 * untagged books alone — book_genres coverage has real gaps (real bestsellers
 * like "Beach Read" and "Da Vinci Code" have zero genre rows in this catalog),
 * so treating "no genre data" as "wrong format" would wrongly filter out
 * genuinely matching books that just aren't tagged yet.
 *
 * Known limitation: only checks for a top-level Fiction ('F%') subject code,
 * so children's fiction (tagged under the 'Y' top-level) isn't recognised as
 * fiction here. Fine for now since onboarding's genre list doesn't include a
 * children's-fiction option, but worth widening if that changes.
 */
function buildFormatCondition(intent: 'fiction' | 'non-fiction' | null) {
  if (!intent) return undefined;

  const hasAnyGenre = sql`EXISTS (SELECT 1 FROM book_genres bg2 WHERE bg2.book_id = ${books.id})`;
  const hasFictionGenre = sql`EXISTS (
    SELECT 1 FROM book_genres bg2
    JOIN genres g2 ON g2.id = bg2.genre_id
    WHERE bg2.book_id = ${books.id} AND g2.subject_code LIKE 'F%'
  )`;

  return intent === 'fiction'
    ? sql`(NOT ${hasAnyGenre} OR ${hasFictionGenre})`
    : sql`(NOT ${hasAnyGenre} OR NOT ${hasFictionGenre})`;
}

/**
 * Books tagged with any subject the reader's quiz genres stand for, or
 * undefined when the fallback should not narrow by genre at all.
 *
 * Narrows only when every genre the reader picked has subjects. A partial
 * mapping would quietly drop the rest: a reader who picked romance and
 * non-fiction would get a romance-only fallback. Not narrowing still keeps the
 * format filter, which is the part of their answer that maps cleanly.
 */
export function buildQuizGenreCondition(quizGenres: string[]): SQL | undefined {
  const subjects = quizGenres.map((g) => quizGenre(g)?.subjects ?? []);
  if (subjects.length === 0 || subjects.some((s) => s.length === 0)) return undefined;

  const prefixes = [...new Set(subjects.flat())];
  const anyPrefix = sql.join(
    prefixes.map((p) => sql`g3.subject_code LIKE ${`${p}%`}`),
    sql` OR `,
  );
  return sql`EXISTS (
    SELECT 1 FROM book_genres bg3
    JOIN genres g3 ON g3.id = bg3.genre_id
    WHERE bg3.book_id = ${books.id} AND (${anyPrefix})
  )`;
}

/**
 * Runs the pgvector similarity search for a preference vector and returns up
 * to TARGET_RESULTS candidate books, ordered best-match-first.
 *
 * Fills the list to TARGET_RESULTS whenever the catalogue allows, in tiers that
 * always rank in this order:
 *
 *   1. strict   — within SIMILARITY_THRESHOLD, deduped on work (normalized
 *                 title + first author, see workKey) by best edition.
 *   2. backfill — the next-nearest books out to BACKFILL_SIMILARITY_THRESHOLD.
 *   3. reach    — the next-nearest books beyond it, at any distance.
 *   4. genre    — in-stock books in the reader's quiz genres, newest first, for
 *                 when the vector search itself runs dry.
 *
 * Tiers 1-3 are cut in memory out of one nearest-first vector search, re-run
 * once with a wider pool only when collapsing editions has left a full pool short.
 * `baseConditions` (sellability, dislikes, format, already-owned books) applies
 * to every tier, so none of them is ever relaxed to make up the numbers — a
 * list can still come back short, but only when fewer than TARGET_RESULTS
 * books in the whole catalogue pass those rules.
 */
// `filler` marks a book that only padded the list (see fetchFillerBatch). It
// never reaches the client — the cache uses it to give a padded list a short
// lease, so a better attempt replaces it sooner.
type CandidateRow = { id: number; title: string; filler?: true };

// The columns dedupeByWork needs to pick the best of several editions of one work,
// fetched alongside id/title and stripped before this function's callers ever see them —
// none of them are part of the {id, title} contract downstream code relies on.
type ScoredCandidateRow = CandidateRow & {
  author: string | null;
  subtitle: null;
  coverUrl: string | null;
  shortDescription: string | null;
  availabilityCode: string | null;
  publicationDate: string | null;
  genreCount: number;
  hasPrice: boolean;
};

/**
 * Whether this Postgres has pgvector's iterative index scan (0.8.0+). Probed
 * once per process and remembered.
 *
 * Asks pg_extension rather than `SHOW hnsw.iterative_scan`. pgvector registers
 * its GUCs when its library is first loaded into a session, which happens
 * lazily on the first vector operation — so on a freshly checked-out pooled
 * connection the SHOW raises `unrecognized configuration parameter` even on
 * 0.8.x, and a probe built on it would report "unsupported" on a server that
 * supports it perfectly well. The catalogue version is readable at any time.
 */
let iterativeScanSupport: Promise<boolean> | null = null;

function supportsIterativeScan(): Promise<boolean> {
  iterativeScanSupport ??= probeIterativeScan().catch((err: unknown) => {
    // Deliberately not memoized. A probe that never reached the server says
    // nothing about the server, and caching its answer would let one blip —
    // a failover, a restart, a saturated pool during the first request after
    // deploy — pin the whole process to the capped-recall path for its
    // lifetime, silently reinstating the single-book bug this widening exists
    // to prevent. Clearing the slot makes the next call probe again; this one
    // degrades safely to a single wide pass.
    iterativeScanSupport = null;
    logger.warn('Could not determine pgvector version — assuming no iterative scan for this query', {
      error: (err as Error).message,
    });
    return false;
  });
  return iterativeScanSupport;
}

/**
 * Reads the answer the server actually gives. Both outcomes here are
 * determinate and safe to remember for the process; only a thrown error (which
 * means "we could not ask") is retried by the caller above.
 */
async function probeIterativeScan(): Promise<boolean> {
  const rows = await db.execute(sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
  const version = (rows as unknown as { extversion?: string }[])[0]?.extversion;
  // No row means the question could not be answered, not that the answer is no.
  if (!version) throw new Error('pgvector not listed in pg_extension');

  const parts = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const supported = compareVersion(parts, MIN_ITERATIVE_SCAN_VERSION) >= 0;
  if (!supported) {
    logger.warn('pgvector predates the iterative index scan — recommendation recall is capped', {
      version,
    });
  }
  return supported;
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * How long a generated list is allowed to live in the two caches. A full list
 * of real matches gets the standard lease. A short list, or one that needed
 * filler to reach TARGET_RESULTS, gets an hour, so one bad search is not
 * frozen in front of every reader who shares those preferences for two days —
 * filler can stand in for a genre fallback that merely ran out of time.
 */
function cacheTtlSecondsFor(results: RecommendationItem[], padded = false): number {
  if (padded) return SHORT_RESULT_CACHE_TTL_HOURS * 60 * 60;
  if (results.length >= TARGET_RESULTS) return CACHE_TTL_HOURS * 60 * 60;
  // Logged rather than silently shortened: a list below TARGET_RESULTS is the
  // symptom to watch if the endpoint starts under-returning again.
  logger.warn('Recommendation list came back short', {
    count: results.length,
    target: TARGET_RESULTS,
  });
  return SHORT_RESULT_CACHE_TTL_HOURS * 60 * 60;
}

/**
 * One batch of the last tier: books passing `baseConditions` (plus `extra`,
 * the genre narrowing when there is one), newest first, skipping `excludeIds`.
 * Does not need an embedding, so it also reaches books still waiting on the
 * embedding backfill.
 *
 * Returns null when the batch hit its statement timeout — the caller stops the
 * fallback there rather than failing the request.
 */
async function fetchFallbackBatch(
  baseConditions: SQL[],
  extra: SQL[],
  excludeIds: number[],
  take: number,
  timeoutMs: number,
): Promise<CandidateRow[] | null> {
  try {
    return await withStatementTimeout(timeoutMs, (conn) =>
      conn
        .select({ id: books.id, title: books.title })
        .from(books)
        .where(and(...baseConditions, ...(excludeIds.length > 0 ? [notInArray(books.id, excludeIds)] : []), ...extra))
        .orderBy(sql`${books.publicationDate} DESC NULLS LAST`, desc(books.id))
        .limit(take),
    );
  } catch (err) {
    if (!isStatementTimeout(err)) throw err;
    logger.warn('Recommendation genre fallback timed out', { budgetMs: GENRE_FALLBACK_BUDGET_MS });
    return null;
  }
}

/**
 * One batch of the filler: popular in-stock books that pass `fillerConditions`,
 * skipping `excludeIds`, most popular first.
 *
 * Popular means what readers have been doing — the trending score over the last
 * TRENDING_WINDOW_DAYS, the same ranking the trending feed uses — and, past the
 * books with any activity, Gardners stock depth, then newest. Deep stock is the
 * distributor's own bet on what sells, and it is always there: the trending
 * signal is thin until the app has a lot of readers.
 */
async function fetchFillerBatch(fillerConditions: SQL[], excludeIds: number[], take: number): Promise<CandidateRow[]> {
  const notExcluded = (ids: number[]) => (ids.length > 0 ? [notInArray(books.id, ids)] : []);

  const since = new Date();
  since.setDate(since.getDate() - TRENDING_WINDOW_DAYS);
  const score = trendingScoreSql();
  // Scored on interactions alone, then filtered: the interaction table is small
  // next to the catalogue, so ranking it first and checking the survivors is
  // far cheaper than joining every in-stock book to its activity.
  const trending = await db
    .select({ bookId: userInteractions.bookId })
    .from(userInteractions)
    .where(
      and(
        gt(userInteractions.createdAt, since),
        inArray(userInteractions.type, TRENDING_SCORED_TYPES),
        ...(excludeIds.length > 0 ? [notInArray(userInteractions.bookId, excludeIds)] : []),
      ),
    )
    .groupBy(userInteractions.bookId)
    .orderBy(sql`${score} DESC`, userInteractions.bookId)
    .limit(take);

  const trendingIds = trending.map((t) => t.bookId);
  let ranked: CandidateRow[] = [];
  if (trendingIds.length > 0) {
    const eligible = await db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(and(inArray(books.id, trendingIds), ...fillerConditions));
    const byId = new Map(eligible.map((r) => [r.id, r]));
    ranked = trendingIds.map((id) => byId.get(id)).filter((r): r is CandidateRow => r !== undefined);
  }
  if (ranked.length >= take) return ranked;

  const stocked = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    // Trending books that failed the filter are skipped too: they would fail it again.
    .where(and(...fillerConditions, ...notExcluded([...excludeIds, ...trendingIds])))
    .orderBy(
      sql`(SELECT max(gs.stock_qty) FROM gardners_stock gs WHERE gs.isbn13 = ${books.isbn13}) DESC NULLS LAST`,
      sql`${books.publicationDate} DESC NULLS LAST`,
      desc(books.id),
    )
    .limit(take - ranked.length);

  return [...ranked, ...stocked];
}

export async function fetchCandidateBooks(
  vectorLiteral: string,
  baseConditions: SQL[],
  quizGenres: string[],
  fillerConditions: SQL[],
): Promise<CandidateRow[]> {
  const distanceExpr = sql`${books.embedding} <=> ${vectorLiteral}::vector`;
  const candidateColumns = {
    id: books.id,
    title: books.title,
    coverUrl: books.coverUrl,
    shortDescription: books.shortDescription,
    availabilityCode: books.availabilityCode,
    publicationDate: books.publicationDate,
    // Selected so the search below can be split into tiers in memory, without
    // a second query to define each boundary.
    distance: sql<number>`${books.embedding} <=> ${vectorLiteral}::vector`,
  };

  // SET LOCAL keeps the GUCs scoped to this one transaction — a bare SET would
  // stick to the pooled connection and change the plan of unrelated queries that
  // reuse it afterwards. max_scan_tuples and scan_mem_multiplier only exist from
  // pgvector 0.8.0, the same release as the iterative scan they bound, so they
  // are set alongside it.
  const fetchRows = async (where: SQL | undefined, limit: number) => {
    const iterative = await supportsIterativeScan();
    return db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL hnsw.ef_search = ${iterative ? HNSW_EF_SEARCH : HNSW_EF_SEARCH_NO_ITERATIVE}`),
      );
      if (iterative) {
        await tx.execute(sql.raw(`SET LOCAL hnsw.iterative_scan = ${HNSW_ITERATIVE_SCAN}`));
        await tx.execute(sql.raw(`SET LOCAL hnsw.max_scan_tuples = ${HNSW_MAX_SCAN_TUPLES}`));
        await tx.execute(sql.raw(`SET LOCAL hnsw.scan_mem_multiplier = ${HNSW_SCAN_MEM_MULTIPLIER}`));
      }
      return tx
        .select(candidateColumns)
        .from(books)
        .where(where)
        .orderBy(distanceExpr)
        .limit(limit);
    });
  };

  // First named A01 author per book, for the work key both tiers dedupe on. Every candidate
  // has one (buildHasAuthorCondition), so a miss here only means the key falls back to title.
  const fetchFirstAuthors = async (ids: number[]): Promise<Map<number, string>> => {
    const firstAuthor = new Map<number, string>();
    if (ids.length === 0) return firstAuthor;
    const contributorRows = await db
      .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
      .from(bookContributors)
      .where(and(inArray(bookContributors.bookId, ids), eq(bookContributors.role, 'A01')))
      .orderBy(bookContributors.sequenceNumber);
    for (const c of contributorRows) {
      if (c.personName?.trim() && !firstAuthor.has(c.bookId)) firstAuthor.set(c.bookId, c.personName);
    }
    return firstAuthor;
  };

  // Attaches genreCount/hasPrice (the two DedupeCandidate fields not directly on `books`)
  // via one batched IN query each, so dedupeByWork can score the pool — same pattern as
  // FeedScoringRow in books.service.ts.
  const withScoring = async (
    rows: Awaited<ReturnType<typeof fetchRows>>,
    firstAuthor: Map<number, string>,
  ): Promise<ScoredCandidateRow[]> => {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [genreCounts, priceRows] = await Promise.all([
      db
        .select({ bookId: bookGenres.bookId, count: sql<number>`COUNT(*)::int` })
        .from(bookGenres)
        .where(inArray(bookGenres.bookId, ids))
        .groupBy(bookGenres.bookId),
      db.selectDistinct({ bookId: bookPrices.bookId }).from(bookPrices).where(inArray(bookPrices.bookId, ids)),
    ]);
    const genreCountById = new Map(genreCounts.map((g) => [g.bookId, g.count]));
    const priceIds = new Set(priceRows.map((p) => p.bookId));
    return rows.map((r) => ({
      ...r,
      author: firstAuthor.get(r.id) ?? null,
      subtitle: null,
      genreCount: genreCountById.get(r.id) ?? 0,
      hasPrice: priceIds.has(r.id),
    }));
  };

  const stripScoring = (r: ScoredCandidateRow): CandidateRow => ({ id: r.id, title: r.title });

  // Nearest first with no distance bound — see the note on
  // BACKFILL_SIMILARITY_THRESHOLD for why the bound came off. The embedding
  // check used to be implied by the bound (a NULL distance is never < x); with
  // it gone it has to be said, or an unembedded book would sort with a NULL
  // distance that Number() reads as 0, a perfect strict match.
  const vectorWhere = and(isNotNull(books.embedding), ...baseConditions);
  const isStrict = (row: { distance: number }) => Number(row.distance) < SIMILARITY_THRESHOLD;

  // Splits one nearest-first result set into the strict tier and the in-order
  // top-up after it. Run once on the normal pool and, if that came back full but
  // short, once more on the wide pool — from scratch, so a strict row first seen
  // in the wide pass is scored with the rest of the strict tier rather than
  // skipped as one already considered.
  const tierVectorRows = async (rows: Awaited<ReturnType<typeof fetchRows>>) => {
    const firstAuthor = await fetchFirstAuthors(rows.map((r) => r.id));
    const keyOf = (row: { id: number; title: string }) => workKey(row.title, firstAuthor.get(row.id) ?? null);

    const strict = dedupeByWork(await withScoring(rows.filter(isStrict), firstAuthor))
      .slice(0, TARGET_RESULTS)
      .map(stripScoring);
    const seenWorks = new Set(strict.map(keyOf));

    // Everything past the strict tier is a strictly worse-match pool, only
    // reached because the strict tier came up short — it exists to top the list
    // off, not to be scored against itself, so it keeps the simple
    // first-seen-work rule rather than the full priority scoring above. Strict
    // rows are skipped: every one of them was already in the dedupe above, and
    // one that lost its work there must not reappear as a worse match here.
    const nearest: (CandidateRow & { tier: 'backfill' | 'reach' })[] = [];
    for (const row of rows) {
      if (strict.length + nearest.length >= TARGET_RESULTS) break;
      if (isStrict(row)) continue;
      const key = keyOf(row);
      if (seenWorks.has(key)) continue;
      seenWorks.add(key);
      const tier = Number(row.distance) < BACKFILL_SIMILARITY_THRESHOLD ? 'backfill' : 'reach';
      nearest.push({ id: row.id, title: row.title, tier });
    }
    return { strict, nearest, seenWorks };
  };

  let rows = await fetchRows(vectorWhere, FETCH_POOL);
  let tiers = await tierVectorRows(rows);

  // A full pool that still left the list short lost its rows to edition
  // collapsing, so a wider pool has more works to offer. A pool that came back
  // short means the search has nothing further — the catalogue ran out under
  // the filters, or the scan hit its tuple or memory cap — and a wider one would
  // only repeat the walk to the same end.
  const filled = () => tiers.strict.length + tiers.nearest.length;
  if (filled() < TARGET_RESULTS && rows.length === FETCH_POOL && FETCH_POOL < WIDE_FETCH_POOL) {
    rows = await fetchRows(vectorWhere, WIDE_FETCH_POOL);
    tiers = await tierVectorRows(rows);
  }

  const { strict: primaryCandidates, seenWorks } = tiers;
  const topUp: (CandidateRow & { tier: 'backfill' | 'reach' | 'genre' | 'filler' })[] = [...tiers.nearest];
  // Every row any tier has looked at, so no later batch hands back a book
  // already placed or already rejected as a duplicate edition.
  const excludeIds = rows.map((r) => r.id);
  const needed = () => TARGET_RESULTS - primaryCandidates.length - topUp.length;

  // The genre tier: the reader's quiz genres first, then — if those run out —
  // anything that passes their rules. Within each, batches are read until the
  // list is full, a batch comes back smaller than asked (that pass is
  // exhausted), or the time budget is spent. A fixed single batch is not enough:
  // a run of new editions of the same few works can fill it and leave the list
  // short while plenty of other books remain.
  if (needed() > 0) {
    const genreCondition = buildQuizGenreCondition(quizGenres);
    const passes: SQL[][] = genreCondition ? [[genreCondition], []] : [[]];
    const deadline = Date.now() + GENRE_FALLBACK_BUDGET_MS;

    fallback: for (const extra of passes) {
      while (needed() > 0) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break fallback;
        const take = needed() * GENRE_FALLBACK_HEADROOM;
        const batch = await fetchFallbackBatch(baseConditions, extra, excludeIds, take, remainingMs);
        if (batch === null) break fallback;

        const batchAuthors = await fetchFirstAuthors(batch.map((r) => r.id));
        for (const row of batch) {
          excludeIds.push(row.id);
          if (needed() <= 0) continue;
          const key = workKey(row.title, batchAuthors.get(row.id) ?? null);
          if (seenWorks.has(key)) continue;
          seenWorks.add(key);
          topUp.push({ id: row.id, title: row.title, tier: 'genre' });
        }
        if (batch.length < take) break;
      }
    }
  }

  // The filler: whatever the tiers above could not supply — because the
  // catalogue has fewer matching books than TARGET_RESULTS, or the genre
  // fallback ran out of time — is padded with popular in-stock books. The
  // reader's format and dislikes give way here; fillerConditions keeps the rules
  // that never do (in stock, and never a book they shelved or rejected).
  for (let batchNo = 0; batchNo < FILLER_MAX_BATCHES && needed() > 0; batchNo += 1) {
    const take = needed() * GENRE_FALLBACK_HEADROOM;
    const batch = await fetchFillerBatch(fillerConditions, excludeIds, take);
    const batchAuthors = await fetchFirstAuthors(batch.map((r) => r.id));
    for (const row of batch) {
      excludeIds.push(row.id);
      if (needed() <= 0) continue;
      const key = workKey(row.title, batchAuthors.get(row.id) ?? null);
      if (seenWorks.has(key)) continue;
      seenWorks.add(key);
      topUp.push({ id: row.id, title: row.title, tier: 'filler' });
    }
    if (batch.length < take) break;
  }

  // Worth seeing in the logs: how far past the close matches a list had to
  // reach, and — as its own warning, with the per-tier counts — a list that
  // still could not be filled.
  const tierCounts = { strict: primaryCandidates.length, backfill: 0, reach: 0, genre: 0, filler: 0 };
  for (const c of topUp) tierCounts[c.tier] += 1;
  if (needed() > 0) {
    logger.warn('Recommendation list could not be filled to target', { ...tierCounts, target: TARGET_RESULTS });
  } else if (tierCounts.reach > 0 || tierCounts.genre > 0 || tierCounts.filler > 0) {
    logger.info('Recommendation list topped up past the backfill cutoff', { ...tierCounts, target: TARGET_RESULTS });
  }

  return [
    ...primaryCandidates,
    ...topUp.map(({ id, title, tier }) => (tier === 'filler' ? { id, title, filler: true as const } : { id, title })),
  ];
}

// ── Public service ────────────────────────────────────────────────────────────

export const recommendationsService = {
  /**
   * The guest onboarding entry point — always unauthenticated, so there is no
   * rejection history to apply. A signed-in reader retaking the quiz goes
   * through `refresh` instead, which loads their exclusions.
   */
  async getRecommendations(input: RecommendationInput): Promise<RecommendationResult> {
    const hash = hashInput(input);
    const now = new Date();
    const redisCacheKey = `recommendations:hash:${hash}`;

    // 1a. Redis fast path — same preferences return without touching Postgres.
    const redisHit = await redis.get(redisCacheKey);
    if (redisHit) {
      logger.info('Recommendation Redis cache hit', { hash });
      // Substituted per reader, not per cache entry — the stored text carries
      // the name token, this caller's name goes in here.
      const cachedResults = personalizeExplanations(
        JSON.parse(redisHit) as RecommendationItem[],
        input.displayName,
      );
      const { id: guestSessionId, expiresAt } = await guestService.create({
        displayName: input.displayName,
        feelings: input.feelings,
        bookIds: input.bookIds,
        genres: input.genres,
        dislikes: input.dislikes,
        recommendationHash: hash,
      });
      return { recommendations: cachedResults, guestSessionId, expiresAt };
    }

    // 1b. DB cache — same preferences within 48 h return instantly.
    //     A fresh guest session is always created regardless of cache state.
    const [cached] = await db
      .select()
      .from(recommendationCache)
      .where(
        and(
          eq(recommendationCache.inputHash, hash),
          gt(recommendationCache.expiresAt, now),
        ),
      )
      .limit(1);

    if (cached) {
      logger.info('Recommendation DB cache hit', { hash });
      const ttlSeconds = Math.floor((cached.expiresAt.getTime() - now.getTime()) / 1000);
      await redis.set(redisCacheKey, JSON.stringify(cached.results), 'EX', ttlSeconds);
      const { id: guestSessionId, expiresAt } = await guestService.create({
        displayName: input.displayName,
        feelings: input.feelings,
        bookIds: input.bookIds,
        genres: input.genres,
        dislikes: input.dislikes,
        recommendationHash: hash,
      });
      return {
        recommendations: personalizeExplanations(cached.results, input.displayName),
        guestSessionId,
        expiresAt,
      };
    }

    logger.info('Recommendation cache miss — generating', { hash });

    // 2. Look up the books the user says they've enjoyed (for preference context)
    const likedBooks = await fetchLikedBooks(input.bookIds);

    // 3. Build the preference text and the weighted search vector.
    // The paragraph still goes to the explanation model — it reads like a person
    // describing their taste. The search vector is built per field so the
    // configured weights apply; see generatePreferenceVector.
    const preferenceText = buildPreferenceText(input, likedBooks);
    const queryVector = await generatePreferenceVector(input, likedBooks);
    // Passed as a parameterised value; postgres driver sends it as $1, cast to vector
    const vectorLiteral = `[${queryVector.join(',')}]`;

    // 4. pgvector cosine similarity search — strict pass first, backfilled
    //    with a looser pass if that doesn't leave enough to hit TARGET_RESULTS.
    //    No stored rejections to exclude on this path: the caller is a guest
    //    who hasn't seen a recommendation list to swipe on yet. Their swipes
    //    land on the guest session and start applying once registration moves
    //    them to a user row.
    const baseConditions: SQL[] = buildBaseConditions(input, likedBooks, EMPTY_EXCLUSIONS);
    const fillerConditions: SQL[] = buildFillerConditions(input, likedBooks, EMPTY_EXCLUSIONS);

    const candidateRows = await fetchCandidateBooks(vectorLiteral, baseConditions, input.genres, fillerConditions);
    const padded = candidateRows.some((r) => r.filler);

    if (candidateRows.length === 0) {
      // Cache the empty result so identical preferences don't re-run the vector search
      const emptyTtlSeconds = cacheTtlSecondsFor([]);
      const cacheExpiresAt = new Date(now.getTime() + emptyTtlSeconds * 1000);
      await Promise.all([
        db
          .insert(recommendationCache)
          .values({ inputHash: hash, results: [], expiresAt: cacheExpiresAt })
          .onConflictDoUpdate({
            target: recommendationCache.inputHash,
            set: { results: [], expiresAt: cacheExpiresAt },
          }),
        redis.set(redisCacheKey, '[]', 'EX', emptyTtlSeconds),
      ]);

      const { id: guestSessionId, expiresAt } = await guestService.create({
        displayName: input.displayName,
        feelings: input.feelings,
        bookIds: input.bookIds,
        genres: input.genres,
        dislikes: input.dislikes,
        recommendationHash: hash,
      });
      return { recommendations: [], guestSessionId, expiresAt };
    }

    const candidateIds = candidateRows.map((r) => r.id);

    // 5. Batch-fetch authors + genres for all candidates (Gemini context)
    const [contributorRows, genreRows] = await Promise.all([
      db
        .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
        .from(bookContributors)
        .where(
          and(
            inArray(bookContributors.bookId, candidateIds),
            eq(bookContributors.role, 'A01'),
          ),
        )
        .orderBy(bookContributors.sequenceNumber),

      db
        .select({ bookId: bookGenres.bookId, name: genres.name })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(inArray(bookGenres.bookId, candidateIds)),
    ]);

    const authorMap = new Map<number, string[]>();
    for (const c of contributorRows) {
      if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
      if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
    }

    const genreMap = new Map<number, string[]>();
    for (const g of genreRows) {
      if (!genreMap.has(g.bookId)) genreMap.set(g.bookId, []);
      genreMap.get(g.bookId)!.push(g.name);
    }

    const bookContexts: BookContext[] = candidateRows.map((r) => ({
      bookId: r.id,
      title: r.title,
      authors: authorMap.get(r.id) ?? [],
      genres: genreMap.get(r.id) ?? [],
    }));

    // 6. Single flash-lite call → one ≤120-char explanation per book
    const explanations = await generateExplanations(preferenceText, bookContexts);
    const explanationMap = new Map(explanations.map((e) => [e.bookId, e.explanation]));

    // 7. Assemble final ranked list (rank = position in cosine similarity order)
    const results: RecommendationItem[] = candidateRows.map((row, index) => ({
      bookId: row.id,
      rank: index + 1,
      explanation: explanationMap.get(row.id) ?? '',
    }));

    // 8. Persist to cache — upsert in case of a race condition on concurrent identical requests
    const ttlSecondsForResults = cacheTtlSecondsFor(results, padded);
    const cacheExpiresAt = new Date(now.getTime() + ttlSecondsForResults * 1000);
    await Promise.all([
      db
        .insert(recommendationCache)
        .values({ inputHash: hash, results, expiresAt: cacheExpiresAt })
        .onConflictDoUpdate({
          target: recommendationCache.inputHash,
          set: { results, expiresAt: cacheExpiresAt },
        }),
      redis.set(redisCacheKey, JSON.stringify(results), 'EX', ttlSecondsForResults),
    ]);

    // 9. Create guest session now that results are ready
    const { id: guestSessionId, expiresAt } = await guestService.create({
      displayName: input.displayName,
      feelings: input.feelings,
      bookIds: input.bookIds,
      genres: input.genres,
      dislikes: input.dislikes,
      recommendationHash: hash,
    });

    // Cached above with the token intact; personalized only on the way out.
    return {
      recommendations: personalizeExplanations(results, input.displayName),
      guestSessionId,
      expiresAt,
    };
  },

  /**
   * Fetches an authenticated user's stored preferences exactly as saved by
   * onboarding (migrateGuestSession) or the most recent `/refresh` call.
   * Read-only — does not touch the embedding or run the recommendation
   * pipeline, unlike `refresh`.
   */
  async getPreferences(userId: number): Promise<Omit<RecommendationInput, 'displayName'>> {
    // Dislikes live in their own append-only table rather than on
    // user_preferences, so they're read alongside rather than from the row.
    const [[row], dislikedBookIds] = await Promise.all([
      db
        .select({
          feelings: userPreferences.feelings,
          genres: userPreferences.genres,
          dislikes: userPreferences.dislikes,
          bookIds: userPreferences.bookIds,
        })
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1),
      dislikedBooksService.listBookIds(userId),
    ]);

    if (!row) {
      throw Object.assign(new Error('Preferences not found'), { statusCode: 404 });
    }

    return { ...row, dislikedBookIds };
  },

  /**
   * Updates a user's stored preferences/embedding from the full quiz payload.
   * By default this is a lightweight save — no recommendation list is
   * computed or returned, since that's an expensive Gemini-backed pipeline
   * most preference edits don't need. Pass includeRecommendations=true to
   * additionally run the full pipeline and get a ranked list back (this is
   * what "Find your next read" on the Home tab relies on).
   *
   * Either way, the response only waits on the plain DB write
   * (`saveUserPreferenceFields`) — the embedding regeneration is always
   * fire-and-forget, since it's a live Gemini call and a "save my
   * preferences" action shouldn't hang or fail because Gemini is slow or
   * down. The personalized feed will pick up the new embedding once that
   * background call completes; until then it keeps serving on the old one.
   *
   * This endpoint no longer records rejections — `saveSelections` owns that
   * write. It still reads them back, because the recommendation pass below
   * filters on the user's accumulated exclusion set regardless of what the
   * caller sent.
   */
  async refresh(
    userId: number,
    input: Omit<RecommendationInput, 'displayName'>,
    includeRecommendations = false,
  ): Promise<Omit<RecommendationInput, 'displayName'> & { recommendations?: RecommendationItem[] }> {
    await saveUserPreferenceFields(userId, input);

    regeneratePreferenceEmbedding(userId, input).catch((err) => {
      logger.error('Failed to regenerate preference embedding after refresh', {
        userId,
        error: (err as Error).message,
      });
    });

    // Echo back the user's whole rejection history, not just what this call
    // added — the client sends a delta but reads back state.
    const dislikedBookIds = await dislikedBooksService.listBookIds(userId);
    const saved = { ...input, dislikedBookIds };

    if (!includeRecommendations) {
      return saved;
    }

    const results = await computeRecommendations(userId, input);
    return { ...saved, recommendations: results };
  },

  /**
   * Saves the books an authenticated user picked from a quiz retake — the
   * logged-in twin of POST /guest-sessions/:id/selections.
   *
   * The guest version parks its results on the session row and waits for
   * registration to turn them into real state. Here there is already a user, so
   * the same work happens directly and immediately: chosen books land on the
   * shelf as want_to_read (not liked) and in the interaction log, and swiped-away books go straight into the
   * permanent rejection history.
   *
   * Reader type is re-inferred from the new picks and written to both
   * `users.readerType` and the preference history, so a retake moves the label
   * settings shows and the cohort the "readers like you" rail reads. The history
   * row is still where the drift over time stays visible.
   *
   * Inference failing leaves the existing reader type in place. It is a
   * nice-to-have label, and a Gemini hiccup is no reason to blank out a type the
   * user already had.
   *
   * Both writes feed the exclusion set, so neither a chosen nor a rejected book
   * can come back in a later quiz.
   */
  async saveSelections(
    userId: number,
    chosenBookIds: number[],
    dislikedBookIds: number[] = [],
  ): Promise<{ readerType: ReaderType | null; books: { id: number; title: string; coverUrl: string | null }[] }> {
    // A book listed twice is one pick, not two — dedup before anything counts
    // or inserts it, so the 5-book cap can't be gamed and the response doesn't
    // echo a book back twice.
    const uniqueChosenIds = [...new Set(chosenBookIds)];

    // Reject unknown book IDs up front rather than letting a foreign key fail
    // mid-transaction — the client sent something that isn't in the catalogue
    // and deserves a 400, not a 500.
    const selectedBooks = await db
      .select({ id: books.id, title: books.title, coverUrl: books.coverUrl })
      .from(books)
      .where(inArray(books.id, uniqueChosenIds));

    if (selectedBooks.length !== uniqueChosenIds.length) {
      const found = new Set(selectedBooks.map((b) => b.id));
      throw Object.assign(
        new Error(`Unknown book IDs: ${uniqueChosenIds.filter((id) => !found.has(id)).join(', ')}`),
        { statusCode: 400 },
      );
    }

    if (dislikedBookIds.length > 0) {
      await dislikedBooksService.record(userId, dislikedBookIds, 'quiz_refresh');
    }

    const readerType = await fetchAndInferReaderType(uniqueChosenIds);

    await db.transaction(async (tx) => {
      // onConflictDoNothing on both: a book already on the shelf keeps the
      // status, note and source the user gave it. Picking it again in a quiz is
      // not a reason to overwrite their own edits — and since shelf books are
      // excluded from quiz results, this should only fire on a stale client.
      await tx
        .insert(userBooks)
        .values(quizPickShelfRows(userId, uniqueChosenIds, 'chosen_from_quiz'))
        .onConflictDoNothing();

      await tx
        .insert(userInteractions)
        .values(
          uniqueChosenIds.map((bookId) => ({
            userId,
            bookId,
            type: 'chosen_from_recommendation',
            weight: 1.0,
          })),
        )
        .onConflictDoNothing();

      // Only written when inference actually produced a type: a null means
      // Gemini failed, not that the reader stopped having a type, so the
      // existing label survives rather than being cleared.
      //
      // Inside the transaction, so a retake never half-lands with the picks on
      // the shelf and the old label still on the profile — the same choice the
      // onboarding path makes (see auth.service.ts). The cost is that a failure
      // here rolls the picks back too, which is the opposite of how the history
      // write below is treated. Deliberate: the picks and the label are one
      // event to the reader, and a retake they have to redo is a better outcome
      // than a profile that silently disagrees with the books under it.
      if (readerType) {
        await tx.update(users).set({ readerType, updatedAt: new Date() }).where(eq(users.id, userId));
      }
    });

    // History is a side record, not the point of the call — a failure to log
    // the snapshot must not fail the user's selection, which is already saved.
    try {
      const prefs = await recommendationsService.getPreferences(userId);
      // `readerType ?? undefined` so a failed inference makes `record` read the
      // user row and carry the existing type forward, rather than writing a null
      // that would read as "this reader has no type" in the history.
      await preferenceHistoryService.record(userId, prefs, 'user_edit', {
        readerType: readerType ?? undefined,
      });
    } catch (err) {
      logger.error('Failed to record preference history after quiz selections', {
        userId,
        error: (err as Error).message,
      });
    }

    // The shelf just grew, and the shelf is part of the exclusion set.
    await bustUserExclusions(userId);

    return { readerType, books: selectedBooks };
  },
};

/**
 * Runs the full recommendation pipeline (cache check → embedding → pgvector
 * search → Gemini explanations → cache write) for a given user/input and
 * returns the ranked results. Shared by `refresh` (always computes) and
 * `updatePreferences` (only computes when the caller opts in via
 * `includeRecommendations`, since it's an expensive Gemini-backed call that
 * most preference edits don't need).
 */
async function computeRecommendations(
  userId: number,
  input: Omit<RecommendationInput, 'displayName'>,
): Promise<RecommendationItem[]> {
  // Re-use the full recommendation pipeline with a placeholder displayName
  // (name is excluded from the cache hash anyway)
  const [userRow] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Only ever used as a hashInput field, which discards it — the hash is
  // name-blind by design. The reader-facing name is `readerName` below, which
  // stays null when we have nothing real, so the explanation degrades to an
  // impersonal sentence rather than greeting someone as "User".
  const displayName = userRow?.name ?? 'User';
  const readerName = userRow?.name ?? null;

  // Everything this user has ever swiped away. Loaded before the cache lookup
  // because it's part of the cache key — a user who rejected three books since
  // their last quiz must not be served the pre-rejection result set.
  const exclusions = await getUserExclusions(userId);

  const hash = hashInput({ displayName, ...input }, exclusions.bookIds);
  const now = new Date();
  const redisCacheKey = `recommendations:hash:${hash}`;

  // Check recommendation cache first — no need to re-run Gemini for identical inputs
  const redisHit = await redis.get(redisCacheKey);
  if (redisHit) {
    return personalizeExplanations(JSON.parse(redisHit) as RecommendationItem[], readerName);
  }

  const [cached] = await db
    .select()
    .from(recommendationCache)
    .where(and(eq(recommendationCache.inputHash, hash), gt(recommendationCache.expiresAt, now)))
    .limit(1);

  if (cached) {
    const ttlSeconds = Math.floor((cached.expiresAt.getTime() - now.getTime()) / 1000);
    await redis.set(redisCacheKey, JSON.stringify(cached.results), 'EX', ttlSeconds);
    return personalizeExplanations(cached.results, readerName);
  }

  // Full pipeline — embedding + pgvector + Gemini explanations
  const likedBooks = await fetchLikedBooks(input.bookIds);
  // The paragraph still goes to the explanation model — it reads like a person
  // describing their taste. The search vector is built per field so the
  // configured weights apply; see generatePreferenceVector.
  const preferenceText = buildPreferenceText(input, likedBooks);
  const queryVector = await generatePreferenceVector(input, likedBooks);
  const vectorLiteral = `[${queryVector.join(',')}]`;

  const baseConditions: SQL[] = buildBaseConditions(input, likedBooks, exclusions);
  const fillerConditions: SQL[] = buildFillerConditions(input, likedBooks, exclusions);

  const candidateRows = await fetchCandidateBooks(vectorLiteral, baseConditions, input.genres, fillerConditions);
  const padded = candidateRows.some((r) => r.filler);

  let results: RecommendationItem[];

  if (candidateRows.length === 0) {
    results = [];
  } else {
    const candidateIds = candidateRows.map((r) => r.id);

    const [contributorRows, genreRows] = await Promise.all([
      db
        .select({ bookId: bookContributors.bookId, personName: bookContributors.personName })
        .from(bookContributors)
        .where(and(inArray(bookContributors.bookId, candidateIds), eq(bookContributors.role, 'A01')))
        .orderBy(bookContributors.sequenceNumber),
      db
        .select({ bookId: bookGenres.bookId, name: genres.name })
        .from(bookGenres)
        .innerJoin(genres, eq(genres.id, bookGenres.genreId))
        .where(inArray(bookGenres.bookId, candidateIds)),
    ]);

    const authorMap = new Map<number, string[]>();
    for (const c of contributorRows) {
      if (!authorMap.has(c.bookId)) authorMap.set(c.bookId, []);
      if (c.personName) authorMap.get(c.bookId)!.push(c.personName);
    }

    const genreMap = new Map<number, string[]>();
    for (const g of genreRows) {
      if (!genreMap.has(g.bookId)) genreMap.set(g.bookId, []);
      genreMap.get(g.bookId)!.push(g.name);
    }

    const bookContexts: BookContext[] = candidateRows.map((r) => ({
      bookId: r.id,
      title: r.title,
      authors: authorMap.get(r.id) ?? [],
      genres: genreMap.get(r.id) ?? [],
    }));

    const explanations = await generateExplanations(preferenceText, bookContexts);
    const explanationMap = new Map(explanations.map((e) => [e.bookId, e.explanation]));

    results = candidateRows.map((row, index) => ({
      bookId: row.id,
      rank: index + 1,
      explanation: explanationMap.get(row.id) ?? '',
    }));
  }

  const ttlSecondsForResults = cacheTtlSecondsFor(results, padded);
  const cacheExpiresAt = new Date(now.getTime() + ttlSecondsForResults * 1000);
  await Promise.all([
    db
      .insert(recommendationCache)
      .values({ inputHash: hash, results, expiresAt: cacheExpiresAt })
      .onConflictDoUpdate({
        target: recommendationCache.inputHash,
        set: { results, expiresAt: cacheExpiresAt },
      }),
    redis.set(redisCacheKey, JSON.stringify(results), 'EX', ttlSecondsForResults),
  ]);

  // Both caches above hold the name token; the name is this reader's alone.
  return personalizeExplanations(results, readerName);
}

/**
 * Writes the structured preference fields only — no Gemini call. This is the
 * part callers need to wait on for a "your save succeeded" confirmation;
 * the embedding regeneration is a separate, slower step (see
 * `regeneratePreferenceEmbedding`) that callers can choose to await or not.
 */
async function saveUserPreferenceFields(
  userId: number,
  input: Omit<RecommendationInput, 'displayName'>,
): Promise<void> {
  // Upsert, not update: a reader who registered without doing the guest quiz
  // has no row yet, and a bare UPDATE would match nothing and report success.
  // The embedding write below then found no row either, leaving them with an
  // empty personalized feed. The embedding is left out of the conflict set so
  // an existing one keeps serving until regeneratePreferenceEmbedding lands.
  const fields = {
    feelings: input.feelings,
    bookIds: input.bookIds,
    genres: input.genres,
    dislikes: input.dislikes,
    updatedAt: new Date(),
  };
  await db
    .insert(userPreferences)
    .values({ userId, ...fields })
    .onConflictDoUpdate({ target: userPreferences.userId, set: fields });

  // Append to the preference audit log. Deliberately not awaited into the
  // user's failure path: the save above already succeeded, and losing one
  // history row is a far better outcome than telling the user their save
  // failed. `record` no-ops when nothing actually changed.
  try {
    // The full rejection set as it stands *after* this save, not just the ones
    // sent in this payload — a history row is a snapshot of the whole taste
    // profile, and dislikes are cumulative.
    const dislikedBookIds = await dislikedBooksService.listBookIds(userId);

    await preferenceHistoryService.record(
      userId,
      {
        feelings: input.feelings,
        bookIds: input.bookIds,
        genres: input.genres,
        dislikes: input.dislikes,
        dislikedBookIds,
      },
      'user_edit',
    );
  } catch (err) {
    logger.error('Failed to record preference history', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Regenerates the stored preference embedding from the given input — a real
 * Gemini embedContent call. Callers that don't need to block the response on
 * Gemini's availability/latency should fire this off and .catch() it rather
 * than awaiting it directly.
 */
export async function regeneratePreferenceEmbedding(
  userId: number,
  input: Omit<RecommendationInput, 'displayName'>,
): Promise<void> {
  const likedBooks = await fetchLikedBooks(input.bookIds);
  const embedding = await generatePreferenceVector(input, likedBooks);

  await db
    .update(userPreferences)
    .set({ preferenceEmbedding: embedding, updatedAt: new Date() })
    .where(eq(userPreferences.userId, userId));

  await bustPersonalizedFeedCache(userId);
}
