import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { signupLimiter, loginLimiter, refreshLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

/**
 * POST /auth/signup
 * Body: { fullName, email, password }
 * Creates a new account and returns tokens.
 */
router.post('/signup', signupLimiter, authController.signup);

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns tokens for an existing account.
 */
router.post('/login', loginLimiter, authController.login);

/**
 * POST /auth/refresh
 * Body: { refreshToken }
 * Issues a new access token without requiring login.
 */
router.post('/refresh', refreshLimiter, authController.refresh);

/**
 * POST /auth/logout
 * Body: { refreshToken }
 * Invalidates the refresh token.
 */
router.post('/logout', authController.logout);

/**
 * POST /auth/social
 * Body: { idToken } — Firebase ID token from the mobile app
 * Signs in or registers via Google, Facebook, or Apple.
 */
router.post('/social', loginLimiter, authController.socialLogin);

/**
 * GET /auth/me
 * Returns the currently authenticated user.
 */
router.get('/me', requireAuth, authController.me);

export default router;
