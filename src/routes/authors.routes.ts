import { Router } from 'express';
import { booksController } from '../controllers/books.controller';

const router = Router();

/**
 * GET /authors/search?q=tolk&limit=8
 * Returns deduplicated author entities (name, book count) matching the query,
 * for browsing by author rather than by book title.
 * Minimum 2 characters. Ranked by: prefix match > word prefix > trigram similarity.
 * Public — no auth required.
 */
router.get('/search', booksController.authorSuggestions);

export default router;
