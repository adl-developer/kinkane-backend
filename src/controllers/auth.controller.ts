import { Request, Response } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { logger } from '../lib/logger';
import { geoService } from '../services/geo.service';
import type { SignupContext } from '../services/auth.service';

// Referral codes are Crockford base32 (no I/L/O/U), but accept anything of the
// right shape and let the lookup decide — a typo'd code has to read as "no
// referral", never as a 400 that blocks the account.
const referralCodeSchema = z.string().trim().regex(/^[0-9A-Za-z]{6,32}$/).optional();

const channelSchema = z.enum(['whatsapp', 'sms', 'email', 'copy', 'link']).optional();

/**
 * Assembles the referral/geography context for a signup.
 *
 * Never throws: geolocation is best-effort, and an account must be creatable
 * when it is unconfigured or fails.
 */
async function buildSignupContext(
  req: Request,
  data: { referralCode?: string; referralChannel?: string },
): Promise<SignupContext> {
  return {
    referralCode: data.referralCode,
    channel: data.referralChannel,
    country: await geoService.resolveFromRequest(req),
  };
}

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[!@#$%^&*()\-_+=\[\]{}|;:,.<>?`~]/, 'Password must contain at least one special character'),
  // Optional — most users go through onboarding first, but it's not required
  guestSessionId: z.string().uuid().optional(),
  // Referral code, when the user arrived through an invite link or typed one on
  // the signup screen. Falls back to whatever is parked on the guest session.
  referralCode: referralCodeSchema,
  referralChannel: channelSchema,
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

const socialSchema = z.object({
  idToken: z.string().min(1),
  // Optional for returning users; required for brand-new accounts (enforced in the service layer)
  guestSessionId: z.string().uuid().optional(),
  referralCode: referralCodeSchema,
  referralChannel: channelSchema,
});

const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[!@#$%^&*()\-_+=\[\]{}|;:,.<>?`~]/, 'Password must contain at least one special character'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const verifyEmailSchema = z.object({
  otp: z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[!@#$%^&*()\-_+=\[\]{}|;:,.<>?`~]/, 'Password must contain at least one special character'),
});

export const authController = {
  async signup(req: Request, res: Response): Promise<void> {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { name, email, password, guestSessionId } = parsed.data;

    try {
      const context = await buildSignupContext(req, parsed.data);
      const { user, tokens } = await authService.signup(name, email, password, guestSessionId, context);
      res.status(201).json({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during signup', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async login(req: Request, res: Response): Promise<void> {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { email, password } = parsed.data;

    try {
      const { user, tokens } = await authService.login(email, password);

      // Only fires for accounts that predate city resolution, and only until it
      // succeeds once — see geoService.backfillCityInBackground. Unawaited: a
      // map pin is never worth delaying a sign-in for.
      geoService.backfillCityInBackground(user.id, req);

      res.status(200).json({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during login', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { accessToken, refreshToken } = await authService.refresh(parsed.data.refreshToken);
      // Return the rotated refresh token alongside the new access token
      res.status(200).json({ accessToken, refreshToken });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during token refresh', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async logout(req: Request, res: Response): Promise<void> {
    const parsed = logoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await authService.logout(parsed.data.refreshToken);
      res.status(200).json({ message: 'Logged out successfully' });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      logger.error('Unexpected error during logout', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  async forgotPassword(req: Request, res: Response): Promise<void> {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await authService.forgotPassword(parsed.data.email);
      // Always return 200 — never reveal whether the email is registered
      res.status(200).json({ message: 'If that email is registered, a reset link has been sent' });
    } catch (err: unknown) {
      const e = err as Error;
      logger.error('Unexpected error during forgot-password', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  async resetPassword(req: Request, res: Response): Promise<void> {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { token, password } = parsed.data;

    try {
      await authService.resetPassword(token, password);
      res.status(200).json({ message: 'Password updated successfully. Please log in again.' });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during password reset', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async verifyEmail(req: Request, res: Response): Promise<void> {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { id } = (req as AuthenticatedRequest).user;

    try {
      await authService.verifyEmail(id, parsed.data.otp);
      res.status(200).json({ message: 'Email verified successfully' });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during email verification', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async resendVerificationEmail(req: Request, res: Response): Promise<void> {
    const { id } = (req as AuthenticatedRequest).user;

    try {
      await authService.resendVerificationEmail(id);
      res.status(200).json({ message: 'If your email is not yet verified, a new link has been sent' });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during verification email resend', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async deleteAccount(req: Request, res: Response): Promise<void> {
    const parsed = deleteAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { id } = (req as AuthenticatedRequest).user;

    try {
      await authService.deleteAccount(id, parsed.data.password);
      res.status(200).json({ message: 'Account deleted successfully' });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during account deletion', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async changePassword(req: Request, res: Response): Promise<void> {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { id } = (req as AuthenticatedRequest).user;
    const { currentPassword, newPassword } = parsed.data;

    try {
      await authService.changePassword(id, currentPassword, newPassword);
      res.status(200).json({ message: 'Password updated successfully' });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during password change', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async me(req: Request, res: Response): Promise<void> {
    const { id } = (req as AuthenticatedRequest).user;
    try {
      const user = await authService.getMe(id);
      res.status(200).json({ user });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error fetching current user', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async socialLogin(req: Request, res: Response): Promise<void> {
    const parsed = socialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const context = await buildSignupContext(req, parsed.data);
      const { user, tokens, isNewUser } = await authService.socialLogin(
        parsed.data.idToken,
        parsed.data.guestSessionId,
        context,
      );

      // Returning social users take the same backfill as returning email ones.
      // New ones already had their city written at signup, and the null guard
      // inside makes this a no-op for them.
      if (!isNewUser) geoService.backfillCityInBackground(user.id, req);

      res.status(isNewUser ? 201 : 200).json({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error during social login', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },
};
