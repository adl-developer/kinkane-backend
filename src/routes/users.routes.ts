import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { usersController } from '../controllers/users.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

// Specific sub-paths must be registered before the /:userId wildcard
router.patch('/follow-requests/:requestId/accept',  wrap(usersController.acceptFollowRequest));
router.patch('/follow-requests/:requestId/decline', wrap(usersController.declineFollowRequest));

router.get('/:userId',         wrap(usersController.getUserProfile));
router.get('/:userId/books',   wrap(usersController.getUserBooks));
router.post('/:userId/follow', wrap(usersController.sendFollowRequest));
router.delete('/:userId/follow', wrap(usersController.withdrawFollowRequest));

export default router;
