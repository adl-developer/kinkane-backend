import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { mentionsController } from '../controllers/mentions.controller';
import { wrapHttp } from '../lib/route-helpers';

const router = Router();

/**
 * GET /api/v1/user/mentions
 *
 * Everywhere the authenticated user has been @-mentioned and told about it,
 * newest first. An entry whose text they can no longer see (a private group
 * they are not in, a post since made private) keeps its place with
 * `restricted: true` and no excerpt.
 *
 * Query: { limit?: 1-50 (default 20), offset?: >=0 (default 0) }
 * Returns 200: { mentions: MentionFeedItem[], total, limit, offset }
 * Errors: 400 invalid query | 401 unauthenticated
 */
router.get('/', requireAuth, wrapHttp(mentionsController.list));

export default router;
