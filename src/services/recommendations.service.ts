import { createHash } from 'crypto';
import { eq, sql, and, inArray, gt } from 'drizzle-orm';
import { db } from '../db';
import { books, bookContributors, bookGenres, genres, userPreferences, users } from '../db/schema';
import { recommendationCache, type RecommendationItem } from '../db/schema/recommendations';
import { generateEmbedding, generateExplanations, type BookContext } from '../lib/gemini';
import { guestService } from './guest.service';
import { logger } from '../lib/logger';
import { redis } from '../lib/redis';

// How many results we aim to return to the client. Kept well below the old
// 250 because each result gets its own synchronous Gemini explanation call —
// fewer results means fewer explanation chunks and a faster response.
const TARGET_RESULTS = 100;
// How large a pool to fetch from the DB before applying the threshold cut.
// Larger than TARGET_RESULTS so the threshold filter still leaves us with 100.
const FETCH_POOL = 2000;
// Cosine distance upper bound — books further than this from the preference
// vector are excluded. Lower = stricter (0 = identical, 1 = orthogonal).
const SIMILARITY_THRESHOLD = 0.5;
const CACHE_TTL_HOURS = 48;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecommendationInput {
  displayName: string;
  feelings: string[];
  bookIds: number[];
  genres: string[];
  dislikes: {
    emotionalTone?: string[];
    pacingStructure?: string[];
    writingStyle?: string[];
    genreFocus?: string[];
    commitmentLevel?: string[];
  };
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
    dislikes: {
      emotionalTone: [...(input.dislikes.emotionalTone ?? [])].sort(),
      pacingStructure: [...(input.dislikes.pacingStructure ?? [])].sort(),
      writingStyle: [...(input.dislikes.writingStyle ?? [])].sort(),
      genreFocus: [...(input.dislikes.genreFocus ?? [])].sort(),
      commitmentLevel: [...(input.dislikes.commitmentLevel ?? [])].sort(),
    },
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
  input: { feelings: string[]; genres: string[]; dislikes: { emotionalTone?: string[]; pacingStructure?: string[]; writingStyle?: string[]; genreFocus?: string[]; commitmentLevel?: string[] } },
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

  const allDislikes = [
    ...(input.dislikes.emotionalTone ?? []),
    ...(input.dislikes.pacingStructure ?? []),
    ...(input.dislikes.writingStyle ?? []),
    ...(input.dislikes.genreFocus ?? []),
    ...(input.dislikes.commitmentLevel ?? []),
  ];

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
 */
function buildDislikeConditions(dislikes: RecommendationInput['dislikes']) {
  const conditions = [];

  if (dislikes.commitmentLevel?.includes('long book (500+ pages)')) {
    conditions.push(
      sql`(${books.pageCount} IS NULL OR ${books.pageCount} < 500)`,
    );
  }

  if (dislikes.commitmentLevel?.includes('series commitment')) {
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

    // 4. pgvector cosine similarity search — fetch a large pool, apply the
    //    similarity threshold to exclude poor fits, then keep the top TARGET_RESULTS.
    const dislikeConditions = buildDislikeConditions(input.dislikes);
    const thresholdCondition = sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${SIMILARITY_THRESHOLD}`;
    const whereClause = and(thresholdCondition, ...dislikeConditions);

    const poolRows = await db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(whereClause)
      .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
      .limit(FETCH_POOL);

    const candidateRows = poolRows.slice(0, TARGET_RESULTS);

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
  const whereClause = and(
    sql`(${books.embedding} <=> ${vectorLiteral}::vector) < ${SIMILARITY_THRESHOLD}`,
    ...dislikeConditions,
  );

  const poolRows = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(whereClause)
    .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
    .limit(FETCH_POOL);

  const candidateRows = poolRows.slice(0, TARGET_RESULTS);

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
