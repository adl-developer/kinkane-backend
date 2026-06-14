import { Router } from 'express';
import { emailChangeController } from '../controllers/email-change.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { emailChangeLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

/**
 * POST /api/v1/email-change/request
 *
 * Initiates an email change for the authenticated user.
 * Checks that the new email is not already taken, then sends a 6-digit OTP
 * to the new address and a cancellation notice to the current address.
 * Any existing pending request for this user is overwritten.
 *
 * Body: { newEmail }
 * Returns 200: { message }
 * Errors: 400 validation | 400 same as current | 409 email taken
 */
router.post('/request', requireAuth, emailChangeLimiter, emailChangeController.requestChange);

/**
 * POST /api/v1/email-change/verify
 *
 * Verifies the OTP and commits the email change.
 * On success the user's email is updated and all active sessions are
 * invalidated — the client should redirect to login.
 *
 * Body: { otp }
 * Returns 200: { message }
 * Errors: 400 invalid/expired OTP | 409 email no longer available
 */
router.post('/verify', requireAuth, emailChangeController.verifyChange);

/**
 * POST /api/v1/email-change/resend
 *
 * Resends a fresh OTP to the pending new email address and issues a
 * new cancellation link to the current email. Resets the 15-minute expiry.
 *
 * Returns 200: { message }
 * Errors: 400 no pending request
 */
router.post('/resend', requireAuth, emailChangeLimiter, emailChangeController.resendOtp);

/**
 * GET /api/v1/email-change/cancel?token=<cancelToken>
 *
 * Cancels a pending email change via the token sent to the old address.
 * No authentication required — the old email owner may have lost account
 * access if it was compromised.
 *
 * Returns 200: { message }
 * Errors: 400 invalid or expired token
 */
router.get('/cancel', emailChangeController.cancelChange);

export default router;
