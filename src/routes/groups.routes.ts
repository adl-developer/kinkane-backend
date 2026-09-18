import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePlus } from '../middleware/require-plus.middleware';
import { groupCreateLimiter, groupInviteLimiter } from '../middleware/rate-limit.middleware';
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

// Membership. Joining is not gated: a Plus member's group has to be joinable by
// the friends they invite, or the feature is pointless. Only creating is gated.
router.get('/:groupId/members', wrapHttp(groupsController.listMembers));
router.post('/:groupId/join', wrapHttp(groupsController.join));
// "membership" rather than "leave" so the path names the thing being removed,
// and so withdrawing an invitation can reuse it later.
router.delete('/:groupId/membership', wrapHttp(groupsController.leave));

// Invitations. Any member can invite, not just the owner — the design puts
// "+ Invite friends" on the plain-member view.
router.get('/:groupId/invitable-friends', wrapHttp(groupsController.listInvitableFriends));
router.post('/:groupId/invites', groupInviteLimiter, wrapHttp(groupsController.invite));
router.post('/:groupId/invites/accept', wrapHttp(groupsController.acceptInvite));
router.post('/:groupId/invites/decline', wrapHttp(groupsController.declineInvite));
// Owner-only. Covers both removing a member and withdrawing a pending
// invitation — the owner is severing the same link either way.
router.delete('/:groupId/members/:userId', wrapHttp(groupsController.removeMember));

export default router;
