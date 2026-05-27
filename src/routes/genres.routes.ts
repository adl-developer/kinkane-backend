import { Router } from 'express';
import { genresController } from '../controllers/genres.controller';

const router = Router();

/**
 * GET /genres
 * Returns all genres with their id, name, and slug.
 * Public — no auth required.
 */
router.get('/', genresController.list);

export default router;
