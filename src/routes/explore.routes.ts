import { Router, Request, Response } from 'express';
import { optionalAuth, requireAuth } from '../middleware/auth.middleware';
import { requirePlus } from '../middleware/require-plus.middleware';
import { exploreController } from '../controllers/explore.controller';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const router = Router();

/**
 * GET /api/v1/explore/trending?limit=10
 *
 * Returns the most interacted-with books over the last 30 days, ranked by
 * weighted interaction score (view + wishlist + chosen_from_recommendation).
 * Falls back to recently published books to fill the list on sparse data.
 * Results are cached in Redis for 1 hour.
 *
 * The ranking is global — everyone sees the same list — with one exception:
 * a signed-in viewer never sees a book they have swiped away, or another
 * edition of one.
 *
 * Query params: limit — number of books to return (1–20, default 10)
 * Returns 200: { books: [{ id, title, coverUrl, isbn13, publicationDate, contributors, genres }] }
 * Public — no auth required. Send a token to get rejected books filtered out.
 */
router.get('/trending', optionalAuth, exploreController.getTrending);

/**
 * GET /api/v1/explore/personalized?limit=10
 *
 * Returns books ranked by cosine similarity to the authenticated user's
 * preference embedding (stored at signup from their onboarding answers).
 * Books already on the user's shelf are excluded.
 * Returns an empty list if the preference embedding is not yet available.
 * Results are cached in Redis for 1 hour per user.
 *
 * Query params: limit — number of books to return (1–20, default 10)
 * Returns 200: { books: [{ id, title, coverUrl, isbn13, publicationDate, contributors, genres }] }
 * Errors: 401 unauthenticated
 */
router.get('/personalized', requireAuth, requirePlus, (req: Request, res: Response) =>
  exploreController.getPersonalized(req as AuthenticatedRequest, res),
);

export default router;
