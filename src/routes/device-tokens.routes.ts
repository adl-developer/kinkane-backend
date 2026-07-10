import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { deviceTokensController } from '../controllers/device-tokens.controller';
import { wrap } from '../lib/route-helpers';

const router = Router();

router.use(requireAuth);

/**
 * POST /api/v1/user/device-tokens
 *
 * Registers (or reassigns) an FCM device token for the authenticated user.
 * Call on login and whenever the client's token refreshes.
 *
 * Body: { fcmToken: string, platform: 'ios' | 'android' }
 * Returns 200: { success: true }
 * Errors: 400 invalid input | 401 unauthenticated
 */
router.post('/', wrap(deviceTokensController.register));

/**
 * DELETE /api/v1/user/device-tokens/:fcmToken
 *
 * Removes a device token, e.g. on logout. Scoped to the authenticated user —
 * cannot delete a token registered to another account.
 *
 * Returns 200: { success: true }
 * Errors: 401 unauthenticated | 404 token not found
 */
router.delete('/:fcmToken', wrap(deviceTokensController.unregister));

export default router;
