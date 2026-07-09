import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
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

/**
 * GET /api/v1/recommendations/preferences
 *
 * Returns the authenticated user's stored reading preferences, as last saved
 * by onboarding or a previous PATCH /refresh call. Read-only — does not
 * touch the embedding or run the recommendation pipeline.
 *
 * Note: the data model currently has no "region" preference — only
 * feelings (mood), genres, dislikes (avoid), and bookIds are stored.
 *
 * Returns 200: { preferences: { feelings, genres, dislikes, bookIds } }
 * Errors: 401 unauthenticated | 404 no preferences saved yet (e.g. never completed onboarding)
 */
router.get('/preferences', requireAuth, (req: Request, res: Response) =>
  recommendationsController.getPreferences(req as AuthenticatedRequest, res),
);

/**
 * PATCH /api/v1/recommendations/refresh?includeRecommendations=true
 *
 * Updates an authenticated user's stored preferences from the full quiz
 * payload (feelings + genres + dislikes + bookIds together — unlike a
 * granular single-field patch, this always requires the whole shape).
 * The preference fields are saved synchronously; the embedding used by the
 * personalized feed is regenerated in the background afterward (a live
 * Gemini call) so this save doesn't hang or fail if Gemini is slow or down —
 * the personalized feed just keeps serving on the old embedding until the
 * regeneration completes, then the cache is invalidated.
 *
 * By default, no recommendation list is computed or returned — this skips
 * the pgvector search + Gemini explanation pipeline entirely, which is the
 * expensive part most preference edits don't need. Pass
 * ?includeRecommendations=true to additionally run that full pipeline and
 * get a ranked list back — this is what "Find your next read" on the Home
 * tab relies on. Shares the same recommendation cache as the guest flow —
 * identical inputs return instantly without a Gemini call.
 *
 * Body: {
 *   feelings: string[3],
 *   bookIds?: number[],
 *   genres: string[3],
 *   dislikes?: { emotionalTone?, pacingStructure?, writingStyle?, genreFocus?, commitmentLevel? }
 * }
 *
 * Returns 200: { preferences: { feelings, genres, dislikes, bookIds } }
 *      or, with ?includeRecommendations=true:
 *         { recommendations: [{ bookId, rank, explanation }] }
 * Errors: 400 validation | 401 unauthenticated | 429 rate limit
 */
router.patch('/refresh', requireAuth, recommendationsLimiter, (req: Request, res: Response) =>
  recommendationsController.refresh(req as AuthenticatedRequest, res),
);

export default router;
