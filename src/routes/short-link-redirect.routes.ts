import { Router } from 'express';
import { shortLinksController } from '../controllers/short-links.controller';
import { shortLinkRedirectLimiter } from '../middleware/rate-limit.middleware';
import { wrap } from '../lib/route-helpers';

const router = Router();

/**
 * GET /l/:code
 *
 * Where every short link in user-written text goes (see lib/link-text). Mounted
 * at the root, like /r, because it is a link people see and share. Not under
 * /redirect: these leave Kinkané for another site, so they must open in a
 * browser rather than be claimed by the app.
 *
 * 302 to the address; 404 page for an unknown code; 410 page for a blocked link.
 */
router.get('/:code', shortLinkRedirectLimiter, wrap(shortLinksController.redirect));

export default router;
