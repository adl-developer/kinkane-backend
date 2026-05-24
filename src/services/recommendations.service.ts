import { createHash } from 'crypto';
import { eq, sql, and, inArray, gt } from 'drizzle-orm';
import { db } from '../db';
import { books, bookContributors, bookGenres, genres } from '../db/schema';
import { recommendationCache, type RecommendationItem } from '../db/schema/recommendations';
import { generateEmbedding, generateExplanations, type BookContext } from '../lib/gemini';
import { guestService } from './guest.service';
import { logger } from '../lib/logger';

// Max books returned per recommendation request — balances quality vs Gemini cost
const CANDIDATE_LIMIT = 250;
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
function buildPreferenceText(
  input: RecommendationInput,
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

    // 1. Check cache — same preferences within 48 h return instantly.
    //    A fresh guest session is always created regardless of cache state.
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
      logger.info('Recommendation cache hit', { hash });
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

    // 4. pgvector cosine similarity search (closest books first) with dislike filters
    const dislikeConditions = buildDislikeConditions(input.dislikes);
    const whereClause = dislikeConditions.length > 0 ? and(...dislikeConditions) : undefined;

    const candidateRows = await db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(whereClause)
      .orderBy(sql`${books.embedding} <=> ${vectorLiteral}::vector`)
      .limit(CANDIDATE_LIMIT);

    if (candidateRows.length === 0) {
      // Cache the empty result so identical preferences don't re-run the vector search
      const cacheExpiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000);
      await db
        .insert(recommendationCache)
        .values({ inputHash: hash, results: [], expiresAt: cacheExpiresAt })
        .onConflictDoUpdate({
          target: recommendationCache.inputHash,
          set: { results: [], expiresAt: cacheExpiresAt },
        });

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
    await db
      .insert(recommendationCache)
      .values({ inputHash: hash, results, expiresAt: cacheExpiresAt })
      .onConflictDoUpdate({
        target: recommendationCache.inputHash,
        set: { results, expiresAt: cacheExpiresAt },
      });

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
};
