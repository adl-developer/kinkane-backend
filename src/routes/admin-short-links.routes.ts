import { Router } from 'express';
import { shortLinksController } from '../controllers/short-links.controller';
import { wrap } from '../lib/route-helpers';

/**
 * Admin surface for short links. Mounted in app.ts behind the same static
 * bearer token as the other operator tooling outside /api/v1.
 */
const router = Router();

/** GET /admin/short-links/:code — the link's address, tap count and block state. */
router.get('/:code', wrap(shortLinksController.adminGet));

/**
 * PATCH /admin/short-links/:code
 *
 * Blocks or unblocks a link everywhere it appears. A blocked link still shows
 * in the text, marked `blocked`, and its short link opens a "removed" page.
 *
 * Body: { blocked: boolean, reason?: string }
 */
router.patch('/:code', wrap(shortLinksController.adminSetBlocked));

export default router;
