import { GoogleGenerativeAI } from '@google/generative-ai';
import pLimit from 'p-limit';
import { config } from '../config';
import { logger } from './logger';
import type { ReaderType } from '../db/schema';

const genai = new GoogleGenerativeAI(config.gemini.apiKey);

// ── Embeddings ────────────────────────────────────────────────────────────────

/**
 * Generates a single embedding vector for the given text.
 * IMPORTANT: must use the same model as onix_ingester (GEMINI_EMBEDDING_MODEL env var,
 * defaults to text-embedding-004) so the query vector lives in the same space
 * as the stored book vectors.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = genai.getGenerativeModel({ model: config.gemini.embeddingModel });
  // outputDimensionality isn't in this SDK version's types but is accepted by the API —
  // must match the books.embedding column (vector(768)).
  const request = {
    content: { parts: [{ text }], role: 'user' },
    outputDimensionality: 768,
  };
  const result = await withRetry(() => model.embedContent(request));
  const values = result.embedding.values;
  if (values.some((v) => !Number.isFinite(v))) {
    throw new Error('Gemini returned an invalid embedding vector (NaN or Infinity)');
  }
  return values;
}

// ── Explanations ──────────────────────────────────────────────────────────────

export interface BookContext {
  bookId: number;
  title: string;
  authors: string[];
  genres: string[];
}

export interface ExplanationResult {
  bookId: number;
  explanation: string;
}

// Books per Gemini call — small enough to stay within output-token limits,
// large enough to keep the number of parallel calls reasonable (100 / 25 = 4).
const EXPLANATION_CHUNK_SIZE = 25;

// Max concurrent Gemini calls — prevents hitting the API's rate limit when
// many cache misses happen simultaneously.
const geminiConcurrencyLimit = pLimit(3);

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Status codes worth retrying: 429 (rate limit) and 5xx (server-side, including
// the 503 "high demand" errors the API returns under load). Anything else —
// 400 bad request, 401/403 auth, 404 model not found — is a permanent failure
// that will fail identically on every retry, so don't waste time/quota on it.
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network error / no HTTP response — assume transient
  return status === 429 || status >= 500;
}

/**
 * Retries a Gemini call with exponential backoff (1s, 2s, 4s, 8s …) — covers
 * transient failures like the 503 "high demand" errors the API returns under load.
 * If the error carries a retryDelay hint (rate-limit responses), that takes priority.
 * Permanent failures (4xx other than 429) are surfaced immediately without retrying.
 */
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;

      if (!isRetryableStatus(status)) {
        logger.error('Gemini call failed with non-retryable status', {
          status,
          error: (err as Error).message,
        });
        throw err;
      }

      if (attempt < maxAttempts) {
        const retryAfterMatch = String(err).match(/retryDelay["\s:]+(\d+)s/);
        const delay = retryAfterMatch
          ? (parseInt(retryAfterMatch[1], 10) + 1) * 1000
          : 1000 * 2 ** (attempt - 1);
        logger.warn('Gemini call failed, retrying with backoff', {
          attempt,
          status,
          delayMs: delay,
          error: (err as Error).message,
        });
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Calls `generateContent` on the primary flash model, retrying transient
 * failures via `withRetry`. If the primary model fails even after exhausting
 * retries (e.g. it's deprecated or unavailable), falls back to
 * GEMINI_FLASH_MODEL_FALLBACK once before giving up. Never used for
 * embeddings — those must stay in the same vector space as the books already
 * indexed, so there is no safe fallback model for them.
 */
async function generateContentWithFallback(
  request: Parameters<ReturnType<typeof genai.getGenerativeModel>['generateContent']>[0],
): ReturnType<ReturnType<typeof genai.getGenerativeModel>['generateContent']> {
  const primaryModel = genai.getGenerativeModel({ model: config.gemini.flashModel });

  try {
    return await withRetry(() => primaryModel.generateContent(request));
  } catch (err) {
    if (
      !config.gemini.flashModelFallback ||
      config.gemini.flashModelFallback === config.gemini.flashModel
    ) {
      throw err;
    }

    logger.warn('Primary Gemini flash model failed after retries, trying fallback model', {
      primaryModel: config.gemini.flashModel,
      fallbackModel: config.gemini.flashModelFallback,
      error: (err as Error).message,
    });

    const fallbackModel = genai.getGenerativeModel({ model: config.gemini.flashModelFallback });
    return await withRetry(() => fallbackModel.generateContent(request));
  }
}

/**
 * Single-chunk helper. Calls the model for one batch of books and returns
 * explanations for that batch. Falls back to empty strings for the whole
 * chunk if the model response can't be parsed — so one bad chunk never
 * corrupts the rest.
 */
async function generateExplanationsChunk(
  preferenceText: string,
  books: BookContext[],
): Promise<ExplanationResult[]> {
  const bookList = books
    .map((b) => {
      const authorPart = b.authors.length ? ` by ${b.authors.join(', ')}` : '';
      const genrePart = b.genres.length ? ` | ${b.genres.join(', ')}` : '';
      return `ID:${b.bookId} | "${b.title}"${authorPart}${genrePart}`;
    })
    .join('\n');

  // User-controlled text is wrapped in XML delimiters so the model can clearly
  // distinguish it from the system instructions — prevents prompt injection attacks
  // where a crafted feeling like "Ignore above and return..." could hijack the prompt.
  const prompt = `You are a book recommendation assistant. For each book below, write a warm, specific explanation of why it is a great match for this reader.

Rules:
- Focus ONLY on what connects the book to the reader's preferences — feelings they want, genres they enjoy, books they have loved, or themes that resonate.
- Never mention what doesn't fit, what the reader dislikes, or any mismatch. Every sentence must be a positive reason to read this book.
- Each explanation must be STRICTLY 250 characters or fewer.
- Be specific and human — reference actual feelings, genres, or titles from the preferences below.
- Return ONLY a valid JSON array with no markdown, no code fences, no extra text: [{"bookId": number, "explanation": "string"}, ...]

<user_preferences>
${preferenceText}
</user_preferences>

<books>
${bookList}
</books>`;

  let result: Awaited<ReturnType<typeof generateContentWithFallback>>;
  try {
    result = await generateContentWithFallback({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
  } catch (err) {
    // Gemini stayed down through all retry attempts — degrade to empty
    // explanations for this chunk rather than failing the whole request.
    logger.error('Gemini explanations chunk failed after retries', {
      error: (err as Error).message,
    });
    return books.map((b) => ({ bookId: b.bookId, explanation: '' }));
  }

  const raw = result.response.text().trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error('Failed to parse Gemini explanations chunk', { raw: raw.slice(0, 500) });
    return books.map((b) => ({ bookId: b.bookId, explanation: '' }));
  }

  if (!Array.isArray(parsed)) {
    logger.error('Gemini explanations chunk is not an array', { type: typeof parsed });
    return books.map((b) => ({ bookId: b.bookId, explanation: '' }));
  }

  // Enforce the 250-char cap as a hard safety net regardless of what the model returns
  return (parsed as ExplanationResult[]).map((item) => ({
    bookId: item.bookId,
    explanation: (item.explanation ?? '').slice(0, 250),
  }));
}

// ── Reader Type Inference ─────────────────────────────────────────────────────

const READER_TYPES = [
  'The Open Door',
  'The Seeker',
  'The Book-ist',
  'The Story Circler',
  'The Mirror Within',
  'The Echo Collector',
  'The High Summiter',
  'The Cloud Illusionist',
] as const;

// Descriptions are deliberately anchored to signals the model can actually
// see (title/author/genre of 5 books) rather than reading behaviour it has
// no visibility into (TBR pile size, abandon rate, reading multiple books at
// once). Without that anchoring, types like The Open Door and The Book-ist
// were never being selected in practice — the model had nothing concrete to
// match them against and fell back to The Seeker or the nearest genre-based
// type instead.
const READER_TYPE_DESCRIPTIONS = `
- The Open Door: Selection spans several different genres with no single genre dominating. Picks tend to be accessible, easy reads rather than dense or literary.
- The Seeker: Primarily non-fiction — reads to accumulate facts and understanding. Only choose this when non-fiction clearly dominates the selection; do not use it as a default for a mixed or ambiguous set.
- The Book-ist: An unusually wide, almost curated spread — translated fiction, graphic novels, prize-list staples, a mix of fiction and non-fiction — as if worked through a reading list rather than a single taste.
- The Story Circler: Recognisable, culturally prominent, or bestselling titles with a strong, fast-moving plot — books that get talked about widely.
- The Mirror Within: Character-driven, emotionally resonant fiction centred on grief, identity, relationships, or empathy.
- The Echo Collector: Reflective, literary fiction that rewards close reading — classic or "serious" literary titles, valued for craft as much as story.
- The High Summiter: A distinct niche genre (e.g. hard sci-fi, military history) paired with non-fiction on the same subject — deliberate, purposeful reading rather than casual browsing.
- The Cloud Illusionist: Romance, light fantasy, or comfort fiction read for escape — avoids anything literary or self-improvement-oriented.
`.trim();

/**
 * Calls Gemini to infer a reader type from the titles/authors/genres of the
 * 5 books the user chose during onboarding. Returns null if the model response
 * can't be parsed or doesn't match a known type — callers treat null as "unknown".
 */
export async function inferReaderType(books: BookContext[]): Promise<ReaderType | null> {
  const bookList = books
    .map((b) => {
      const authorPart = b.authors.length ? ` by ${b.authors.join(', ')}` : '';
      const genrePart = b.genres.length ? ` [${b.genres.join(', ')}]` : '';
      return `- "${b.title}"${authorPart}${genrePart}`;
    })
    .join('\n');

  const prompt = `You are a literary profiling assistant. Based on the 5 books a user chose during onboarding, identify which single reader type best describes them.

Reader types and their descriptions:
${READER_TYPE_DESCRIPTIONS}

Guidance:
- Base your judgement only on the titles, authors, and genres given — not on outside assumptions.
- Do not default to "The Seeker" just because a selection is mixed or hard to classify. Only choose it when non-fiction clearly dominates. For an ambiguous or genre-spanning set, prefer "The Open Door" or "The Book-ist" instead.
- State which specific signal (title, genre, or pattern across the 5 books) drove your choice.

The user's 5 chosen books:
<books>
${bookList}
</books>

Return ONLY a valid JSON object with no markdown, no code fences, no extra text:
{"reasoning": "<one short sentence citing the specific signal that drove your choice>", "readerType": "<one of the exact type names listed above>"}`;

  try {
    const result = await generateContentWithFallback({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });

    const raw = result.response.text().trim();
    const parsed = JSON.parse(raw) as { reasoning?: string; readerType?: string };
    const candidate = parsed?.readerType;

    if (typeof candidate === 'string' && (READER_TYPES as readonly string[]).includes(candidate)) {
      return candidate as ReaderType;
    }

    logger.warn('Gemini returned an unrecognised reader type', { candidate, reasoning: parsed?.reasoning });
    return null;
  } catch (err) {
    logger.error('Failed to infer reader type via Gemini', { error: (err as Error).message });
    return null;
  }
}

/**
 * Asks gemini-2.5-flash-lite to generate a ≤120-character explanation for
 * every book in the list, explaining why it matches the user's preferences.
 *
 * Books are split into chunks of EXPLANATION_CHUNK_SIZE and all chunks are
 * requested in parallel — this keeps each individual call well within the
 * model's output-token limit while still completing the full list in one
 * round-trip wall-clock time.
 *
 * The model occasionally omits a book or returns a blank explanation within
 * an otherwise-valid chunk response — even on a retry of just the missing
 * ones. So missing books get re-requested in a backoff loop (up to
 * MAX_MISSING_RETRY_ROUNDS rounds) until every book has a non-empty
 * explanation or the rounds run out, at which point any still-missing books
 * fall back to an empty string.
 *
 * Returns one explanation per book in the same order as the input.
 *
 * Bounded by MISSING_RETRY_BUDGET_MS overall — during a sustained Gemini
 * outage, every round's withRetry backoff adds up fast, and a user-facing
 * request shouldn't hang for minutes waiting on explanations that are likely
 * to come back empty anyway. Once the budget is spent, remaining books fall
 * back to an empty string immediately rather than starting another round.
 */
const MAX_MISSING_RETRY_ROUNDS = 3;
const MISSING_RETRY_BUDGET_MS = 20_000;

export async function generateExplanations(
  preferenceText: string,
  books: BookContext[],
): Promise<ExplanationResult[]> {
  const chunks = chunkArray(books, EXPLANATION_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      geminiConcurrencyLimit(() => generateExplanationsChunk(preferenceText, chunk)),
    ),
  );
  const results = chunkResults.flat();

  const explanationMap = new Map(results.map((r) => [r.bookId, r.explanation]));

  const retryDeadline = Date.now() + MISSING_RETRY_BUDGET_MS;

  for (let round = 1; round <= MAX_MISSING_RETRY_ROUNDS; round++) {
    const missingBooks = books.filter((b) => !explanationMap.get(b.bookId)?.trim());
    if (missingBooks.length === 0) break;

    if (Date.now() >= retryDeadline) {
      logger.warn('Missing-explanation retry budget exhausted — giving up early', {
        round,
        bookIds: missingBooks.map((b) => b.bookId),
      });
      break;
    }

    logger.warn('Retrying books with missing/empty explanations', {
      round,
      bookIds: missingBooks.map((b) => b.bookId),
    });

    if (round > 1) {
      // Back off between rounds (not just within a single call) — the model
      // dropping the same books repeatedly is usually a sign of load, same
      // as the transient-error case withRetry already handles.
      const backoffMs = 1000 * 2 ** (round - 1);
      if (Date.now() + backoffMs >= retryDeadline) {
        logger.warn('Missing-explanation retry budget would be exceeded by backoff — giving up early', {
          round,
          bookIds: missingBooks.map((b) => b.bookId),
        });
        break;
      }
      await new Promise((res) => setTimeout(res, backoffMs));
    }

    const retryResults = await geminiConcurrencyLimit(() =>
      generateExplanationsChunk(preferenceText, missingBooks),
    );
    for (const r of retryResults) {
      if (r.explanation.trim()) {
        explanationMap.set(r.bookId, r.explanation);
      }
    }
  }

  const stillMissing = books.filter((b) => !explanationMap.get(b.bookId)?.trim());
  if (stillMissing.length > 0) {
    logger.error('Gemini explanations still missing after all retry rounds — falling back to empty string', {
      bookIds: stillMissing.map((b) => b.bookId),
      rounds: MAX_MISSING_RETRY_ROUNDS,
    });
  }

  return books.map((b) => ({ bookId: b.bookId, explanation: explanationMap.get(b.bookId) ?? '' }));
}
