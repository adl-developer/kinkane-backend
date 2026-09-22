import { Router } from 'express';
import { genresController } from '../controllers/genres.controller';

const router = Router();

/**
 * GET /genres
 * Returns every top-level genre once, with its id, name, and slug. The slug
 * filters GET /books by the whole top level (see lib/genre-display).
 * Public — no auth required.
 */
router.get('/', genresController.list);

export default router;
