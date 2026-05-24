import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { logger } from './logger';

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
  return result.embedding.values;
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

/**
 * Asks gemini-2.5-flash-lite to generate a ≤120-character explanation for
 * each book in the list, explaining why it matches the user's preferences.
 * Returns one explanation per book in the same order as the input.
 *
 * Falls back to an empty string per book if the model response can't be parsed,
 * so the rest of the recommendation result is never lost.
 */
export async function generateExplanations(
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
  const prompt = `You are a book recommendation assistant. Generate short, specific explanations for why each book matches this reader's preferences.

<user_preferences>
${preferenceText}
</user_preferences>

For each book below, write ONE explanation that is STRICTLY 120 characters or fewer.
Be specific — reference a feeling, genre, or preference from the user_preferences above that connects to this book.
Return ONLY a valid JSON array with no markdown, no code fences, no extra text:
[{"bookId": number, "explanation": "string"}, ...]

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
    logger.error('Failed to parse Gemini explanations response', { raw: raw.slice(0, 500) });
    // Graceful fallback — return empty strings so the ranked IDs are still usable
    return books.map((b) => ({ bookId: b.bookId, explanation: '' }));
  }

  if (!Array.isArray(parsed)) {
    logger.error('Gemini explanations response is not an array', { type: typeof parsed });
    return books.map((b) => ({ bookId: b.bookId, explanation: '' }));
  }

  // Enforce the 120-char cap as a hard safety net regardless of what the model returns
  return (parsed as ExplanationResult[]).map((item) => ({
    bookId: item.bookId,
    explanation: (item.explanation ?? '').slice(0, 120),
  }));
}
