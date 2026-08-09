import { Router } from 'express';
import { booksController } from '../controllers/books.controller';
import { optionalAuth, requireAuth } from '../middleware/auth.middleware';

const router = Router();

/**
 * GET /books/search?q=harr&limit=8&type=all|title|author
 * Typeahead suggestions — returns up to 15 ranked matches as the user types.
 * `q` matches the book's title and its author's name by default (`type=all`),
 * so typing an author returns that author's books; pass `type=title` or
 * `type=author` to match only one side. Always returns books, ranked by:
 * prefix match > word prefix > trigram similarity > full-text search fallback.
 * Title matches lead, but author matches keep a reserved share of the list so
 * they can't be crowded out by a query that also happens to match titles.
 * Minimum 1 character. Public — no auth required.
 *
 * NOTE: must be defined before /:id so Express does not treat "search" as an ID.
 */
router.get('/search', booksController.suggestions);

/**
 * GET /books
 * Query params: q, genre, availability, productForm, publishingStatus, publisher, limit, offset
 * `q` matches both title and author name. Title matches rank first, except when
 * nothing matched a title properly — then an exact author match outranks the
 * fuzzy title near-misses. `total` stays capped for searches (see
 * totalIsApproximate); paginate on `hasMore`.
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
 * has no embedding yet. Requires authentication.
 */
router.get('/:id/similar', requireAuth, booksController.similar);

export default router;
