import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.middleware';
import { contactLimiter } from '../middleware/rate-limit.middleware';
import { wrapHttp } from '../lib/route-helpers';
import { contactController } from '../controllers/contact.controller';

const router = Router();

/**
 * POST /api/v1/contact
 *
 * The Contact Us form. Public — the people most likely to need it are the ones
 * who cannot get into their account.
 *
 * Body: { name, email, subject, message, website? }
 *
 * `website` is a honeypot: it is hidden from real users, so anything in it is
 * a bot. Those submissions get a 201 and go nowhere, because a 400 would tell
 * whoever is scripting it which field to stop filling in.
 *
 * The message is stored before it is emailed, and a failed send does not fail
 * the request — see contact.service for why.
 *
 * Returns 201: { received: true }
 * Errors: 400 validation | 429 rate limited
 */
router.post('/', contactLimiter, optionalAuth, wrapHttp(contactController.submit));

export default router;
