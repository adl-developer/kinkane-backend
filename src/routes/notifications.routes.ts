import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';
import { notificationsController } from '../controllers/notifications.controller';

const router = Router();

/**
 * GET /api/v1/user/notifications
 *
 * Returns the authenticated user's notifications feed — a merge of persisted
 * post-like/post-comment notifications and a live view over pending/resolved
 * friend requests, sorted by createdAt descending.
 *
 * Query (all optional): { limit?: 1-50 (default 20), offset?: >=0 (default 0) }
 * Returns 200: { notifications: [...], total, unreadCount, limit, offset }
 * Errors: 400 invalid query | 401 unauthenticated
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  notificationsController.list(req as AuthenticatedRequest, res),
);

/**
 * PATCH /api/v1/user/notifications/read
 *
 * Marks one or more notifications as read. Only applies to persisted
 * notification rows (post_like, post_comment) — friend-request items are
 * resolved via the existing follow-request accept/decline endpoints.
 *
 * Body: { ids: number[] } (1-50 ids)
 * Returns 200: { success: true }
 * Errors: 400 invalid input | 401 unauthenticated
 */
router.patch('/read', requireAuth, (req: Request, res: Response) =>
  notificationsController.markRead(req as AuthenticatedRequest, res),
);

export default router;
