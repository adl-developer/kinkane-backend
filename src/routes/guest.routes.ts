import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis';
import { guestController } from '../controllers/guest.controller';

const sendCommand = (...args: string[]) =>
  (redis as unknown as { call: (...a: string[]) => Promise<unknown> }).call(...args) as Promise<import('rate-limit-redis').RedisReply>;

// 60 lookups per 15 minutes — enough for normal client polling on app resume,
// tight enough to prevent enumeration of valid session UUIDs.
const guestSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many requests — please try again later' }),
  store: new RedisStore({ prefix: 'rl:guest:', sendCommand }),
});

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
router.post('/:id/selections', guestSessionLimiter, guestController.saveSelections);

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
router.get('/:id', guestSessionLimiter, guestController.getById);

export default router;
