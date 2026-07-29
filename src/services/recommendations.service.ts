import { createHash } from 'crypto';
import { eq, sql, and, inArray, notInArray, gt, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { books, bookContributors, bookGenres, genres, userPreferences, users } from '../db/schema';
import { recommendationCache, type RecommendationItem } from '../db/schema/recommendations';
import type { Dislikes } from '../db/schema/onboarding';
import { dedupeByTitle } from '../lib/dedupe';
import { generateEmbedding, generateExplanations, type BookContext } from '../lib/gemini';
import { guestService } from './guest.service';
import { preferenceHistoryService } from './preference-history.service';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';

// How many results we aim to return to the client. Kept well below the old
// 250 because each result gets its own synchronous Gemini explanation call —
// fewer results means fewer explanation chunks and a faster response.
const TARGET_RESULTS = 100;
// How large a pool to fetch per pass (both the strict and backfill passes
// below use this same cap). Larger than TARGET_RESULTS so title dedup still
// tends to leave us with 100.
const FETCH_POOL = 1000;
// Cosine distance upper bound — books further than this from the preference
// vector are excluded. Lower = stricter (0 = identical, 1 = orthogonal).
const SIMILARITY_THRESHOLD = 0.5;
// For narrow/niche preference combinations, fewer than TARGET_RESULTS books
// fall within SIMILARITY_THRESHOLD out of 1M+ in the catalogue. Rather than
// return a short list, a second pass loosens the cutoff to this value and
// fills the remainder — those backfilled books are always ranked after every
// strict match (see fetchCandidateBooks).
const BACKFILL_SIMILARITY_THRESHOLD = 0.7;
const CACHE_TTL_HOURS = 48;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecommendationInput {
  displayName: string;
  feelings: string[];
  bookIds: number[];
  genres: string[];
  dislikes: Dislikes;
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
function hashInput(input: RecommendationInput): string {
  const normalized = {
    feelings: [...input.feelings].sort(),
    bookIds: [...input.bookIds].sort((a, b) => a - b),
    genres: [...input.genres].sort(),
    // Categories are open, so the hash is built from the flat sorted label set.
    // That also makes the cache key indifferent to which category a label was
    // filed under — if the UI moves "slow paced" from one group to another, the
    // preferences are still the same preferences.
    dislikes: flattenDislikes(input.dislikes).sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Fetches the title and primary authors for books the user says they've enjoyed. */
async function fetchLikedBooks(
  bookIds: number[],
): Promise<{ id: number; title: string; authors: string[] }[]> {
  if (bookIds.length === 0) return [];

  // Run both queries in parallel — they have no dependency on each other
  const [rows, contributors] = await Promise.all([
    db
      .select({ id: books.id, title: books.title })
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

  return rows.map((r) => ({ id: r.id, title: r.title, authors: authorMap.get(r.id) ?? [] }));
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

// Coarse fiction / non-fiction bucketing of the genre options exposed at
// onboarding (see GENRE_VALUES in recommendations.controller.ts). pgvector
// similarity alone doesn't enforce format — a self-help book can embed close
// enough to "escapism, romance" to show up in the candidate pool — so this
// backs the similarity search with an explicit format constraint.
const FICTION_GENRES = new Set([
  'literary fiction',
  'mystery',
  'romance',
  'horror',
  'sci-fi',
  'historical fiction',
  'fantasy',
  'crime',
  'young adult',
  'classics',
  'graphic novel',
]);

const NONFICTION_GENRES = new Set([
  'self-help',
  'business',
  'biography',
  'non-fiction',
  'society & education',
  'sport',
  'politics',
  'health & lifestyle',
  'travel',
]);
// 'poetry' is deliberately left unbucketed — it spans both fiction and
// non-fiction shelving conventions and shouldn't force a format filter either way.

/**
 * Returns 'fiction' or 'non-fiction' only when every genre the user picked
 * falls unambiguously on one side. A mixed selection (or one made up entirely
 * of unbucketed genres like poetry) returns null, meaning "don't filter by
 * format" rather than guessing at intent.
 */
function resolveFormatIntent(genreSelections: string[]): 'fiction' | 'non-fiction' | null {
  const sides = new Set(
    genreSelections
      .map((g) => (FICTION_GENRES.has(g) ? 'fiction' : NONFICTION_GENRES.has(g) ? 'non-fiction' : null))
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
 * Runs the pgvector similarity search for a preference vector and returns up
 * to TARGET_RESULTS candidate books, ordered best-match-first.
 *
 * Two passes: a strict pass at SIMILARITY_THRESHOLD, then — only if that
 * leaves fewer than TARGET_RESULTS after title dedup — a backfill pass at
 * the looser BACKFILL_SIMILARITY_THRESHOLD to fill the remainder. Backfilled
 * books always sort after every strict match, so overall rank still reflects
 * match quality. `baseConditions` (dislikes, format, already-owned books)
 * applies identically to both passes.
 */
async function fetchCandidateBooks(
  vectorLiteral: string,
  baseConditions: SQL[],
): Promise<{ id: number; title: string }[]> {
  const distanceExpr = sql`${books.embedding} <=> ${vectorLiteral}::vector`;

  const primaryRows = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(and(sql`${distanceExpr} < ${SIMILARITY_THRESHOLD}`, ...baseConditions))
    .orderBy(distanceExpr)
    .limit(FETCH_POOL);

  const primaryCandidates = dedupeByTitle(primaryRows).slice(0, TARGET_RESULTS);

  if (primaryCandidates.length >= TARGET_RESULTS) {
    return primaryCandidates;
  }

  const stillNeeded = TARGET_RESULTS - primaryCandidates.length;
  const excludeIds = primaryCandidates.map((r) => r.id);
  const seenTitles = new Set(primaryCandidates.map((r) => r.title.trim().toLowerCase()));

  const backfillRows = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(
      and(
        sql`${distanceExpr} >= ${SIMILARITY_THRESHOLD}`,
        sql`${distanceExpr} < ${BACKFILL_SIMILARITY_THRESHOLD}`,
        ...baseConditions,
        ...(excludeIds.length > 0 ? [notInArray(books.id, excludeIds)] : []),
      ),
    )
    .orderBy(distanceExpr)
    .limit(FETCH_POOL);

  const backfillCandidates: { id: number; title: string }[] = [];
  for (const row of backfillRows) {
    const key = row.title.trim().toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    backfillCandidates.push(row);
    if (backfillCandidates.length >= stillNeeded) break;
  }

  return [...primaryCandidates, ...backfillCandidates];
}

// ── Public service ────────────────────────────────────────────────────────────

export const recommendationsService = {
  async getRecommendations(input: RecommendationInput): Promise<RecommendationResult> {
    const hash = hashInput(input);
    const now = new Date();
    const redisCacheKey = `recommendations:hash:${hash}`;

    // 1a. Redis fast path — same preferences return without touching Postgres.
    const redisHit = await redis.get(redisCacheKey);
    if (redisHit) {
      logger.info('Recommendation Redis cache hit', { hash });
      const cachedResults = JSON.parse(redisHit) as RecommendationItem[];
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
      return { recommendations: cached.results, guestSessionId, expiresAt };
    }

    logger.info('Recommendation cache miss — generating', { hash });

    // 2. Look up the books the user says they've enjoyed (for preference context)
    const likedBooks = await fetchLikedBooks(input.bookIds);

    // 3. Build natural-language preference text and embed it
    const preferenceText = buildPreferenceText(input, likedBooks);
    const queryVector = await generateEmbedding(preferenceText);
    // Passed as a parameterised value; postgres driver sends it as $1, cast to vector
    const vectorLiteral = `[${queryVector.join(',')}]`;

    // 4. pgvector cosine similarity search — strict pass first, backfilled
    //    with a looser pass if that doesn't leave enough to hit TARGET_RESULTS.
    const dislikeConditions = buildDislikeConditions(input.dislikes);
    const formatCondition = buildFormatCondition(resolveFormatIntent(input.genres));
    const baseConditions: SQL[] = [
      ...dislikeConditions,
      ...(formatCondition ? [formatCondition] : []),
      ...(input.bookIds.length > 0 ? [notInArray(books.id, input.bookIds)] : []),
    ];

    const candidateRows = await fetchCandidateBooks(vectorLiteral, baseConditions);

    if (candidateRows.length === 0) {
      // Cache the empty result so identical preferences don't re-run the vector search
      const cacheExpiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
      await Promise.all([
        db
          .insert(recommendationCache)
          .values({ inputHash: hash, results: [], expiresAt: cacheExpiresAt })
          .onConflictDoUpdate({
            target: recommendationCache.inputHash,
            set: { results: [], expiresAt: cacheExpiresAt },
          }),
        redis.set(redisCacheKey, '[]', 'EX', CACHE_TTL_HOURS * 60 * 60),
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
    const cacheExpiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
    await Promise.all([
      db
        .insert(recommendationCache)
        .values({ inputHash: hash, results, expiresAt: cacheExpiresAt })
        .onConflictDoUpdate({
          target: recommendationCache.inputHash,
          set: { results, expiresAt: cacheExpiresAt },
        }),
      redis.set(redisCacheKey, JSON.stringify(results), 'EX', CACHE_TTL_HOURS * 60 * 60),
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

    return { recommendations: results, guestSessionId, expiresAt };
  },

  /**
   * Fetches an authenticated user's stored preferences exactly as saved by
   * onboarding (migrateGuestSession) or the most recent `/refresh` call.
   * Read-only — does not touch the embedding or run the recommendation
   * pipeline, unlike `refresh`.
   */
  async getPreferences(userId: number): Promise<Omit<RecommendationInput, 'displayName'>> {
    const [row] = await db
      .select({
        feelings: userPreferences.feelings,
        genres: userPreferences.genres,
        dislikes: userPreferences.dislikes,
        bookIds: userPreferences.bookIds,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);

    if (!row) {
      throw Object.assign(new Error('Preferences not found'), { statusCode: 404 });
    }

    return row;
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

    if (!includeRecommendations) {
      return input;
    }

    const results = await computeRecommendations(userId, input);
    return { ...input, recommendations: results };
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

  const displayName = userRow?.name ?? 'User';

  const hash = hashInput({ displayName, ...input });
  const now = new Date();
  const redisCacheKey = `recommendations:hash:${hash}`;

  // Check recommendation cache first — no need to re-run Gemini for identical inputs
  const redisHit = await redis.get(redisCacheKey);
  if (redisHit) {
    return JSON.parse(redisHit) as RecommendationItem[];
  }

  const [cached] = await db
    .select()
    .from(recommendationCache)
    .where(and(eq(recommendationCache.inputHash, hash), gt(recommendationCache.expiresAt, now)))
    .limit(1);

  if (cached) {
    const ttlSeconds = Math.floor((cached.expiresAt.getTime() - now.getTime()) / 1000);
    await redis.set(redisCacheKey, JSON.stringify(cached.results), 'EX', ttlSeconds);
    return cached.results;
  }

  // Full pipeline — embedding + pgvector + Gemini explanations
  const likedBooks = await fetchLikedBooks(input.bookIds);
  const preferenceText = buildPreferenceText(input, likedBooks);
  const queryVector = await generateEmbedding(preferenceText);
  const vectorLiteral = `[${queryVector.join(',')}]`;

  const dislikeConditions = buildDislikeConditions(input.dislikes);
  const formatCondition = buildFormatCondition(resolveFormatIntent(input.genres));
  const baseConditions: SQL[] = [
    ...dislikeConditions,
    ...(formatCondition ? [formatCondition] : []),
    ...(input.bookIds.length > 0 ? [notInArray(books.id, input.bookIds)] : []),
  ];

  const candidateRows = await fetchCandidateBooks(vectorLiteral, baseConditions);

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

  const cacheExpiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
  await Promise.all([
    db
      .insert(recommendationCache)
      .values({ inputHash: hash, results, expiresAt: cacheExpiresAt })
      .onConflictDoUpdate({
        target: recommendationCache.inputHash,
        set: { results, expiresAt: cacheExpiresAt },
      }),
    redis.set(redisCacheKey, JSON.stringify(results), 'EX', CACHE_TTL_HOURS * 60 * 60),
  ]);

  return results;
}

// Bust personalized feed cache for all limit variants. `limit` is bounded to
// 1-20 by explore.controller's limitSchema, so we delete the exact bounded
// key set directly rather than scanning the keyspace with KEYS — KEYS is an
// O(N) blocking operation over the *entire* Redis instance and must never
// run on every preference update in production.
async function bustPersonalizedCache(userId: number): Promise<void> {
  const PERSONALIZED_CACHE_MAX_LIMIT = 20;
  const keys = Array.from(
    { length: PERSONALIZED_CACHE_MAX_LIMIT },
    (_, i) => `personalized:v1:${userId}:${i + 1}`,
  );
  await redis.del(...keys);
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
  await db
    .update(userPreferences)
    .set({
      feelings: input.feelings,
      bookIds: input.bookIds,
      genres: input.genres,
      dislikes: input.dislikes,
      updatedAt: new Date(),
    })
    .where(eq(userPreferences.userId, userId));

  // Append to the preference audit log. Deliberately not awaited into the
  // user's failure path: the save above already succeeded, and losing one
  // history row is a far better outcome than telling the user their save
  // failed. `record` no-ops when nothing actually changed.
  try {
    await preferenceHistoryService.record(
      userId,
      {
        feelings: input.feelings,
        bookIds: input.bookIds,
        genres: input.genres,
        dislikes: input.dislikes,
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
async function regeneratePreferenceEmbedding(
  userId: number,
  input: Omit<RecommendationInput, 'displayName'>,
): Promise<void> {
  const likedBooks = await fetchLikedBooks(input.bookIds);
  const preferenceText = buildPreferenceText(input, likedBooks);
  const embedding = await generateEmbedding(preferenceText);

  await db
    .update(userPreferences)
    .set({ preferenceEmbedding: embedding, updatedAt: new Date() })
    .where(eq(userPreferences.userId, userId));

  await bustPersonalizedCache(userId);
}
