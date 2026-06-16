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
  const result = await model.embedContent(text);
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
// large enough to keep the number of parallel calls reasonable (250 / 25 = 10).
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
  const model = genai.getGenerativeModel({ model: config.gemini.flashModel });

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

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json' },
  });

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

const READER_TYPE_DESCRIPTIONS = `
- The Open Door: Embraces all genres but gravitates to a few favourites. Enjoys easy reads and is open to different writing styles and non-linear storylines.
- The Seeker: Primarily non-fiction. Reads to accumulate facts and meaning. Sticks to known genres but will explore if a topic interests them.
- The Book-ist: Organised, list-driven reader. Reads any genre once committed. Follows prize lists, maintains large TBR piles, often reads multiple books at once.
- The Story Circler: Reads what their social circle reads or what's trending. Prefers clear plots and active storylines. Will abandon books they don't connect with quickly.
- The Mirror Within: Connects emotionally. Gravitates to books that engage feelings and empathy. Will over-connect with certain genres and may avoid topics that deeply affect them.
- The Echo Collector: Reflective, introverted reader. Seeks books that linger and encourage contemplation. Appreciates literary and challenging texts. Rarely abandons a book.
- The High Summiter: Purposeful, competitive reader. Tracks statistics. Reads fiction and non-fiction; likely has a niche genre (e.g. sci-fi). Reads long and short books deliberately.
- The Cloud Illusionist: Light, comfort-driven reader. Mainly fiction — romance, drama, light fantasy. Avoids overly literary styles. Reads for escape, not self-improvement.
`.trim();

/**
 * Calls Gemini to infer a reader type from the titles/authors/genres of the
 * 5 books the user chose during onboarding. Returns null if the model response
 * can't be parsed or doesn't match a known type — callers treat null as "unknown".
 */
export async function inferReaderType(books: BookContext[]): Promise<ReaderType | null> {
  const model = genai.getGenerativeModel({ model: config.gemini.flashModel });

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

The user's 5 chosen books:
<books>
${bookList}
</books>

Return ONLY a valid JSON object with no markdown, no code fences, no extra text:
{"readerType": "<one of the exact type names listed above>"}`;

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' },
    });

    const raw = result.response.text().trim();
    const parsed = JSON.parse(raw) as { readerType?: string };
    const candidate = parsed?.readerType;

    if (typeof candidate === 'string' && (READER_TYPES as readonly string[]).includes(candidate)) {
      return candidate as ReaderType;
    }

    logger.warn('Gemini returned an unrecognised reader type', { candidate });
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
 * Returns one explanation per book in the same order as the input.
 */
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
  return chunkResults.flat();
}
