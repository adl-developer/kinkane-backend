import { Router } from 'express';
import { guestController } from '../controllers/guest.controller';

const router = Router();

/**
 * POST /api/v1/guest-sessions/:id/selections
 * Body: { chosenBookIds: number[] }  — the 5 books the user picked from recommendations.
 * Returns: { ok: true }
 */
router.post('/:id/selections', guestController.saveSelections);

/**
 * GET /api/v1/guest-sessions/:id
 * Lets the client check whether a stored session UUID is still alive.
 * Returns: { guestSessionId, displayName, expiresAt }
 */
router.get('/:id', guestController.getById);

export default router;
