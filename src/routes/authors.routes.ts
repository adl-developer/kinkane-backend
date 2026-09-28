import { Router } from 'express';
import { booksController } from '../controllers/books.controller';

const router = Router();

/**
 * GET /authors/search?q=barbara&limit=8&offset=0
 * Every contributor name matching the query, a page at a time: { authors, limit, offset, hasMore }.
 * Word order and punctuation are ignored ("Shakespeare, William" = "William Shakespeare").
 * Ranked: exact matches (prefix > word prefix > any-order words) before fuzzy near-misses,
 * then authors before other roles, then by book count.
 * Public — no auth required.
 */
router.get('/search', booksController.authorSuggestions);

export default router;
