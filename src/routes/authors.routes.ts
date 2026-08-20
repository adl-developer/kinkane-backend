import { Router } from 'express';
import { booksController } from '../controllers/books.controller';
import { authorsController } from '../controllers/authors.controller';

const router = Router();

/**
 * GET /authors/search?q=tolk&limit=8
 * Returns deduplicated author entities (name, book count) matching the query,
 * for browsing by author rather than by book title.
 * Minimum 1 character. Ranked by: prefix match > word prefix > trigram similarity.
 * Public — no auth required.
 */
router.get('/search', booksController.authorSuggestions);

/**
 * GET /api/v1/authors/:slug
 *
 * One author, addressed by the slug of their name (`tayari-jones`). There is no
 * authors table — an author is a distinct contributor name — so the slug *is*
 * the identity, derived by authorSlug() in lib/author-slug and resolved through
 * an index on the same expression.
 *
 * Scoped to primary authors (ONIX role A01): an illustrator or translator does
 * not get a page from that contribution.
 *
 * Returns 200: { slug, name, bookCount }
 * Errors: 400 malformed slug | 404 no author, or all their titles withdrawn
 */
router.get('/:slug', authorsController.get);

/**
 * GET /api/v1/authors/:slug/books?limit=20&offset=0
 *
 * That author's books, newest first, undated titles last. Same book shape as
 * every other list in the API.
 *
 * Returns 200: { books: [...], total, hasMore }
 * Errors: 400 validation | 404 no such author
 */
router.get('/:slug/books', authorsController.books);

export default router;
