import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlus } from '../middleware/require-plus.middleware';
import { groupCreateLimiter } from '../middleware/rate-limit.middleware';
import { groupsController } from '../controllers/groups.controller';
import { wrapHttp } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

// Creating a group is gated; everything else is not. Founding a book club is
// the "create durable content other people consume" side that post and comment
// creation are already gated on. Joining, browsing and reporting stay free —
// gating joins would make a Plus member's invites useless to their friends.
router.post('/', requirePlus, groupCreateLimiter, wrapHttp(groupsController.create));

// Static paths before the /:groupId wildcard
router.get('/mine', wrapHttp(groupsController.listMine));

router.get('/', wrapHttp(groupsController.list));
router.get('/:groupId', wrapHttp(groupsController.get));
router.patch('/:groupId', wrapHttp(groupsController.update));
router.delete('/:groupId', wrapHttp(groupsController.remove));

export default router;
