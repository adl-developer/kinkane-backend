import { Router } from 'express';
import { booksController } from '../controllers/books.controller';
import { optionalAuth } from '../middleware/auth.middleware';

const router = Router();

/**
 * GET /books/search?q=harr&limit=8&type=title|author
 * Typeahead suggestions — returns up to 15 ranked matches as the user types.
 * `type` toggles whether `q` matches against the book title (default) or the
 * author's name — both return books, ranked by: prefix match > word prefix >
 * trigram similarity > full-text search fallback.
 * Minimum 2 characters. Public — no auth required.
 *
 * NOTE: must be defined before /:id so Express does not treat "search" as an ID.
 */
router.get('/search', booksController.suggestions);

/**
 * GET /books
 * Query params: q, genre, availability, productForm, publishingStatus, publisher, limit, offset
 * Public — no auth required.
 */
router.get('/', booksController.list);

/**
 * GET /books/:id
 * Returns full book detail including descriptions, subjects, contributors, genres, prices.
 * Public — no auth required. If a valid access token is supplied, the response
 * also includes `userStatus` (the caller's shelf entry for this book: reading
 * status, liked flag, note) — null if they have no entry, or if the request
 * is unauthenticated.
 */
router.get('/:id', optionalAuth, booksController.getById);

/**
 * GET /books/:id/similar?limit=10
 * Returns books ranked by cosine similarity to the given book's embedding
 * ("You May Also Like"). Excludes the book itself. Empty list if the book
 * has no embedding yet. Public — no auth required.
 */
router.get('/:id/similar', booksController.similar);

export default router;
