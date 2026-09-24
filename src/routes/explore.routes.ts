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
 * Books the shop cannot sell never appear on either path, and every row carries
 * the live price and stock — on the fallback as well as the chart. Neither is a
 * flag the caller passes.
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

/**
 * GET /api/v1/explore/reader-type?limit=20&offset=0
 *
 * "Readers like you loved" — books the rest of the caller's reader type has
 * responded well to, most-supported first.
 *
 * A book counts when a cohort member liked it, finished it, or named it as one
 * they enjoyed in the onboarding quiz or a retake. Each person counts once per
 * book however many of those apply, and the caller's own shelf never counts
 * towards a book's score — "readers like you" means other readers.
 *
 * The cohort is drawn from every user sharing the reader type, whatever their
 * shelf visibility, because the response is an anonymous aggregate: books only,
 * no names and no counts. That trade is what the privacy of this endpoint rests
 * on, so **do not add a liker count or an avatar row to this response** without
 * first making the query filter on shelf_visibility.
 *
 * Books already on the caller's shelf and books they have swiped away are
 * excluded, at work level — a paperback on the shelf suppresses the hardback
 * too. Editions are collapsed, so a title appears once however many formats the
 * catalogue carries.
 *
 * Matching uses `users.reader_type`, which is set at signup and updated by each
 * quiz retake — so retaking the quiz can move a reader into a different cohort
 * and change this rail. See booksService.likedByReaderType.
 *
 * **Returns 200 with an empty array** when the caller has no reader type, and
 * when no one else shares theirs. Both mean the same thing to a client: hide
 * the rail. There is no error case to branch on.
 *
 * Unlike the other feeds here these rows carry **no price or stock** — this is a
 * discovery carousel, not a shop surface, so there are no `unitPriceMinor` /
 * `inStock` fields to read. Books the shop cannot sell are still excluded, so
 * the rail never advertises something unbuyable.
 *
 * Pass `readerType` to read a cohort other than your own — the exact enum value,
 * URL-encoded (e.g. `readerType=The%20Seeker`). Omit it and the caller's own type
 * is used. Validated against the database enum, so an unknown value is a 400 and
 * not an empty rail that looks identical to a cohort nobody else is in. This is
 * what lets a reader with no type of their own see anything at all here, and what
 * makes the endpoint testable before there are real cohorts.
 *
 * Query params: limit      — 1–50 (default 20)
 *               offset     — 0+ (default 0)
 *               readerType — optional; one of the 8 reader types
 * Returns 200: { books: [...], pagination: { total, limit, offset, hasMore } }
 * Errors: 400 validation
 *
 * Public — no auth required, and never requirePlus. The likes feeding it are
 * Plus-generated, but seeing what a cohort loved is discovery rather than a
 * member benefit, and this is exactly the rail that shows someone what Kinkané
 * readers are reading before they have an account of their own.
 *
 * Send a token and the rail personalises itself: the caller's own reader type
 * selects the cohort, their likes stop counting toward it, and their shelf and
 * rejections are filtered out. Signed out, none of those are knowable, so the
 * cohort has to be named with `readerType` and the list comes back unfiltered.
 */
router.get('/reader-type', optionalAuth, exploreController.getReaderTypeLikes);

export default router;
