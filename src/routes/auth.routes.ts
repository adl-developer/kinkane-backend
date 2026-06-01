import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { signupLimiter, loginLimiter, refreshLimiter, passwordResetLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

/**
 * POST /api/v1/auth/signup
 *
 * Creates a new email/password account. The user must have completed the
 * onboarding quiz first — `guestSessionId` is required and is used to migrate
 * their preferences, chosen books, and interaction signals onto the new account.
 * A 90-day Kinkane Plus trial is started synchronously before tokens are returned.
 *
 * Body: { name, email, password, guestSessionId }
 * Returns 201: { user: { id, name, email, emailVerified }, accessToken, refreshToken }
 * Errors: 400 validation | 409 email already registered
 */
router.post('/signup', signupLimiter, authController.signup);

/**
 * POST /api/v1/auth/login
 *
 * Authenticates an existing email/password account and issues a new token pair.
 * Timing-safe — returns the same 401 whether the email doesn't exist or the
 * password is wrong, to prevent account enumeration.
 *
 * Body: { email, password }
 * Returns 200: { user: { id, name, email, emailVerified }, accessToken, refreshToken }
 * Errors: 401 invalid credentials
 */
router.post('/login', loginLimiter, authController.login);

/**
 * POST /api/v1/auth/refresh
 *
 * Exchanges a valid refresh token for a new access token + rotated refresh token.
 * The submitted refresh token is deleted immediately — each token can only be
 * used once. Store the new refreshToken returned in the response.
 *
 * Body: { refreshToken }
 * Returns 200: { accessToken, refreshToken }
 * Errors: 401 token not found or expired
 */
router.post('/refresh', refreshLimiter, authController.refresh);

/**
 * POST /api/v1/auth/logout
 *
 * Deletes the refresh token from the database, immediately invalidating it.
 * The access token expires naturally (15 min TTL). For a true hard logout,
 * discard the access token on the client side as well.
 *
 * Body: { refreshToken }
 * Returns 200: { message: "Logged out successfully" }
 */
router.post('/logout', authController.logout);

/**
 * POST /api/v1/auth/social
 *
 * Signs in or registers using a Firebase ID token (Google, Facebook, or Apple).
 * If no account exists for this provider identity, one is created and a 90-day
 * Kinkane Plus trial is started. If an account with the same email already
 * exists, the social provider is linked to it (no new account, no trial).
 *
 * `guestSessionId` is required for new registrations — it migrates the
 * onboarding data onto the new account in the background.
 * For returning users (paths 1 and 2) the field is optional and ignored.
 *
 * Body: { idToken, guestSessionId }
 * Returns 201 (new account) or 200 (returning user):
 *   { user: { id, name, email, emailVerified }, accessToken, refreshToken }
 * Errors: 400 validation | 401 invalid Firebase token | 422 no email on social account
 */
router.post('/social', loginLimiter, authController.socialLogin);

/**
 * POST /api/v1/auth/forgot-password
 *
 * Sends a password reset link to the given email address.
 * Always returns 200 regardless of whether the email is registered —
 * this prevents account enumeration.
 *
 * Body: { email }
 * Returns 200: { message }
 */
router.post('/forgot-password', passwordResetLimiter, authController.forgotPassword);

/**
 * POST /api/v1/auth/reset-password
 *
 * Validates the reset token and updates the user's password.
 * The token expires after 1 hour and is single-use.
 * On success, all active sessions (refresh tokens) are invalidated.
 *
 * Body: { token, password }
 * Returns 200: { message }
 * Errors: 400 invalid/expired token | 400 password validation failure
 */
router.post('/reset-password', passwordResetLimiter, authController.resetPassword);

/**
 * DELETE /api/v1/auth/account
 *
 * Permanently deletes the authenticated user's account and all associated data
 * (library, preferences, interactions, subscription). A goodbye email is sent
 * after deletion. The client should discard the access token on receipt of 200.
 *
 * Body: { password }
 * Returns 200: { message }
 * Errors: 400 missing password | 400 social account | 401 wrong password
 */
router.delete('/account', requireAuth, authController.deleteAccount);

/**
 * POST /api/v1/auth/change-password
 *
 * Allows an authenticated user to change their password by providing
 * their current password and a new one. Social-only accounts (no password)
 * receive a 400.
 *
 * Body: { currentPassword, newPassword }
 * Returns 200: { message }
 * Errors: 400 validation | 400 social-only account | 401 wrong current password
 */
router.post('/change-password', requireAuth, authController.changePassword);

/**
 * GET /api/v1/auth/me
 *
 * Returns the full profile of the currently authenticated user.
 * Requires a valid Bearer access token in the Authorization header.
 *
 * Returns 200: {
 *   user: {
 *     id, name, email, emailVerified, photoUrl,
 *     subscription: { tier, status, effectiveTier, trialEndsAt },
 *     providers: string[]   // e.g. ['google.com', 'password']
 *   }
 * }
 * Errors: 401 missing or expired token | 404 user not found
 */
router.get('/me', requireAuth, authController.me);

export default router;
