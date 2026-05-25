import { Router } from 'express';
import { guestController } from '../controllers/guest.controller';

const router = Router();

/**
 * POST /api/v1/guest-sessions/:id/selections
 *
 * Saves the books the user chose from the recommendations screen. Must be
 * called after POST /recommendations and before the user registers. The
 * chosen book IDs are stored on the guest session and migrated onto the
 * user's reading list (user_books) and interaction signals (user_interactions)
 * when they create an account.
 *
 * Params: id — the guestSessionId returned by POST /recommendations
 * Body:   { chosenBookIds: number[] }  — 1 to 5 book IDs
 * Returns 200: { ok: true }
 * Errors: 400 invalid UUID or validation failure | 404 session not found or expired
 */
router.post('/:id/selections', guestController.saveSelections);

/**
 * GET /api/v1/guest-sessions/:id
 *
 * Checks whether a stored guestSessionId is still alive. Call this on app
 * resume to decide whether to prompt the user to redo the onboarding flow
 * or proceed straight to registration.
 *
 * Params: id — the guestSessionId to look up
 * Returns 200: { guestSessionId, displayName, expiresAt }
 * Errors: 400 invalid UUID format | 404 session not found or expired
 */
router.get('/:id', guestController.getById);

export default router;
