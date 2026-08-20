import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { wrapHttp } from '../lib/route-helpers';
import { savedBooksController } from '../controllers/saved-books.controller';

const router = Router();

/**
 * Saved Books — the shop's purchase wishlist ("Books you've marked to purchase
 * later"), distinct from the reading list in /user-books.
 *
 * `requireAuth` only, and deliberately **no `requirePlus` anywhere**: this is a
 * customer's shopping wishlist, and putting it behind a subscription would mean
 * charging people for the privilege of wanting to spend money. Same rule the
 * cart and orders follow.
 *
 * Nothing is stored for a signed-out visitor — a guest keeps saved books on
 * their device and replays them here once they have an account, exactly as the
 * basket does.
 */

/**
 * GET /api/v1/saved-books?limit=20&offset=0&currency=GBP
 *
 * Newest first, priced live through the same gate that charges at checkout.
 * Books that have become unbuyable are **kept and flagged**, not dropped —
 * `unavailable` with a reason — so a saved title never silently disappears.
 *
 * Returns 200: { books: [...], total, hasMore }
 * Errors: 400 validation | 401 unauthenticated
 */
router.get('/', requireAuth, wrapHttp(savedBooksController.list));

/**
 * POST /api/v1/saved-books   { bookId }
 *
 * Idempotent — saving a book twice is the same as saving it once.
 *
 * Returns 200: { saved: true }
 * Errors: 400 validation | 401 unauthenticated | 404 unknown or withdrawn book
 */
router.post('/', requireAuth, wrapHttp(savedBooksController.add));

/**
 * DELETE /api/v1/saved-books/:bookId
 *
 * Also idempotent: removing something that was not saved is a success, so a
 * double-tap on the heart cannot produce an error the user has to understand.
 *
 * Returns 200: { removed: boolean }
 * Errors: 400 invalid id | 401 unauthenticated
 */
router.delete('/:bookId', requireAuth, wrapHttp(savedBooksController.remove));

export default router;
