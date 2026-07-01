import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';
import { notificationPreferencesController } from '../controllers/notification-preferences.controller';

const router = Router();

/**
 * GET /api/v1/user/notification-preferences
 *
 * Returns the authenticated user's notification preferences.
 *
 * Returns 200: { notificationPreferences: { newBookSuggestions, rateReviewReminders,
 *   friendRequests, comments, likes } }
 * Errors: 401 unauthenticated
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  notificationPreferencesController.get(req as AuthenticatedRequest, res),
);

/**
 * PATCH /api/v1/user/notification-preferences
 *
 * Toggles one or more notification preference categories. Omitted fields are
 * left unchanged. All fields default to true on account creation.
 *
 * Body (all optional): { newBookSuggestions?, rateReviewReminders?,
 *   friendRequests?, comments?, likes? }
 * Returns 200: { notificationPreferences: { ... } }
 * Errors: 400 invalid input | 401 unauthenticated
 */
router.patch('/', requireAuth, (req: Request, res: Response) =>
  notificationPreferencesController.update(req as AuthenticatedRequest, res),
);

export default router;
