import { Router } from 'express';
import { booksController } from '../controllers/books.controller';

const router = Router();

/**
 * GET /books/search?q=harr&limit=8
 * Typeahead suggestions — returns up to 15 ranked matches as the user types.
 * Minimum 2 characters. Ranked by: prefix match > word prefix > trigram similarity.
 * Public — no auth required.
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
 * Public — no auth required.
 */
router.get('/:id', booksController.getById);

export default router;
