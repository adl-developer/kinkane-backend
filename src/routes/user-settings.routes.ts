import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.middleware';
import { userSettingsController } from '../controllers/user-settings.controller';

const router = Router();

/**
 * GET /api/v1/user/settings
 *
 * Returns all settings for the authenticated user.
 *
 * Returns 200: { settings: { shelfVisibility: 'public' | 'friends' | 'private' } }
 * Errors: 401 unauthenticated | 404 user not found
 */
router.get('/', requireAuth, (req: Request, res: Response) =>
  userSettingsController.getUserSettings(req as AuthenticatedRequest, res),
);

/**
 * PATCH /api/v1/user/settings/shelf-visibility
 *
 * Updates the visibility of the authenticated user's book shelf.
 *   - public  — visible to all Kinkane users
 *   - friends — visible only to mutual friends/followers
 *   - private — visible only to the user themselves
 *
 * Body: { visibility: 'public' | 'friends' | 'private' }
 * Returns 200: { shelfVisibility: 'public' | 'friends' | 'private' }
 * Errors: 400 invalid value | 401 unauthenticated
 */
router.patch('/shelf-visibility', requireAuth, (req: Request, res: Response) =>
  userSettingsController.updateShelfVisibility(req as AuthenticatedRequest, res),
);

export default router;
