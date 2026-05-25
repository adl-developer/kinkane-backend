import { Router } from 'express';
import { recommendationsController } from '../controllers/recommendations.controller';
import { recommendationsLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

/**
 * POST /api/v1/recommendations
 *
 * The entry point for the onboarding flow. Takes the user's quiz answers,
 * embeds them as a preference vector (text-embedding-004), runs a pgvector
 * cosine similarity search against the book catalogue, then calls
 * gemini-2.5-flash-lite to generate a ≤120-char explanation per book.
 *
 * Results are cached in `recommendation_cache` for 48 hours keyed on a
 * SHA-256 hash of the preferences. The user's name is excluded from the hash —
 * two people with identical tastes share the same cached results. A fresh
 * guest session is always created regardless of cache state.
 *
 * Body: {
 *   displayName: string,          — name entered in step 1 of onboarding
 *   feelings: string[3],          — exactly 3 (preset labels or freeform ≤200 chars)
 *   bookIds?: number[],           — up to 10 books they've already enjoyed
 *   genres: string[3],            — exactly 3 from the allowed genre enum
 *   dislikes?: {                  — reading experiences to avoid (all sub-fields optional)
 *     emotionalTone?: string[],
 *     pacingStructure?: string[],
 *     writingStyle?: string[],
 *     genreFocus?: string[],
 *     commitmentLevel?: string[]  — "long book (500+ pages)" and/or "series commitment"
 *                                    apply hard SQL filters before the similarity search
 *   }
 * }
 *
 * Returns 200: {
 *   recommendations: [{ bookId, rank, explanation }],
 *   guestSessionId: string,   — store this immediately; required for the next two steps
 *   expiresAt: string         — ISO timestamp when the guest session expires
 * }
 * Errors: 400 validation | 429 rate limit (20 req/hour — each uncached request calls Gemini)
 */
router.post('/', recommendationsLimiter, recommendationsController.getRecommendations);

export default router;
