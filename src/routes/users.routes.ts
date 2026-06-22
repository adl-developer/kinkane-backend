import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { followRequestLimiter } from '../middleware/rate-limit.middleware';
import { usersController } from '../controllers/users.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

// Specific sub-paths must be registered before the /:userId wildcard
router.get('/follow-requests',                      wrap(usersController.listPendingFollowRequests));
router.patch('/follow-requests/:requestId/accept',  wrap(usersController.acceptFollowRequest));
router.patch('/follow-requests/:requestId/decline', wrap(usersController.declineFollowRequest));

router.get('/:userId',           wrap(usersController.getUserProfile));
router.get('/:userId/books',     wrap(usersController.getUserBooks));
router.get('/:userId/followers', wrap(usersController.listFollowers));
router.get('/:userId/following', wrap(usersController.listFollowing));
router.post('/:userId/follow', followRequestLimiter, wrap(usersController.sendFollowRequest));
router.delete('/:userId/follow', wrap(usersController.withdrawFollowRequest));

export default router;
