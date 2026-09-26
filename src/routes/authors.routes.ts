import { Router } from 'express';
import { booksController } from '../controllers/books.controller';

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
 * GET /authors/:name?limit=20
 * One author: their biography where we hold a safe one, and their books,
 * newest first. `bio` is null both when we have nothing and when the name is
 * shared by people with different biographies.
 * Public — no auth required.
 */
router.get('/:name', booksController.authorDetail);

export default router;
