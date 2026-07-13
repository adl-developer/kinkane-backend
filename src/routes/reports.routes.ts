import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { reportsController } from '../controllers/reports.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/v1/reports
 *
 * Files a report against another user, optionally citing the post/review
 * that prompted it.
 *
 * Body: { reportedUserId: number, reason: string, postId?: number }
 * Returns 201: { report: UserReport }
 * Errors: 400 invalid input / self-report / post-user mismatch | 401 unauthenticated | 404 user or post not found
 */
router.post('/', wrap(reportsController.submit));

export default router;
