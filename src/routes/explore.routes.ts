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
 * GET /api/v1/explore/bestsellers?window=30d&limit=10
 *
 * The books most copies have actually been bought of, in that order.
 *
 * Built from our own order history: Gardners supplies price, stock and
 * availability but no sales rank or units-sold data of any kind, so there is no
 * external chart to read. `gardners_promotions` is deliberately not used —
 * promotional titles are publisher marketing spend, not sales performance.
 *
 * When nothing sold in the window the response carries trending books instead,
 * with `source: 'trending'`. Check that field before labelling the section:
 * `'orders'` is a sales chart, `'trending'` is a discovery feed. Both paths
 * return the same book shape, so one card component renders either.
 *
 * `shoppable=true` restricts to sellable books and attaches the live shop
 * fields, on the fallback as well as the chart.
 *
 * Returns an EMPTY `books` array when nothing has sold in the window. It never
 * substitutes another feed — a discovery list presented as a sales chart would
 * be indistinguishable from a real one, and untrue. Clients should hide the
 * section when the list is empty. Cached for an hour, cleared nightly.
 *
 * Query params: window — 7d | 30d | 90d | all_time (default 30d)
 *               limit  — 1–20 (default 10)
 * Returns 200: { window, source: 'orders', books: [...] }
 * Public — no auth required. The ranking is factual and identical for everyone,
 * so nothing is filtered per viewer.
 */
router.get('/bestsellers', optionalAuth, exploreController.getBestsellers);

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
