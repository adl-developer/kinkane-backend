import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { reportsController } from '../controllers/reports.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/v1/reports
 *
 * Files a report against another user or against a group. `targetType` selects
 * which, and defaults to 'user' when absent so clients written before groups
 * were reportable keep working unchanged.
 *
 * Body (user):  { targetType?: 'user', reportedUserId: number, reason: string, postId?: number }
 * Body (group): { targetType: 'group', reportedGroupId: number, reason: string }
 *
 * The group form is strict: sending reportedUserId or postId alongside
 * reportedGroupId is a 400 rather than being silently ignored, because naming
 * both a group and a user is ambiguous. postId is meaningless for a group.
 * There is no self-report rule for groups — reporting your own is pointless
 * rather than harmful.
 *
 * Both kinds share one R### reference series.
 *
 * Returns 201: { report: UserReport }
 * Errors: 400 invalid input / self-report / mixed target / post-user mismatch
 *       | 401 unauthenticated | 404 user, group or post not found
 */
router.post('/', wrap(reportsController.submit));

export default router;
