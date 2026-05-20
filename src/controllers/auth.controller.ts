import { Request, Response } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';

const signupSchema = z.object({
  fullName: z.string().min(1, 'Full name is required').max(500),
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128),
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
});

export const authController = {
  async signup(req: Request, res: Response): Promise<void> {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { fullName, email, password } = parsed.data;

    try {
      const { user, tokens } = await authService.signup(fullName, email, password);
      res.status(201).json({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
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
      res.status(200).json({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { accessToken } = await authService.refresh(parsed.data.refreshToken);
      res.status(200).json({ accessToken });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
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
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async me(req: Request, res: Response): Promise<void> {
    // req.user is set by requireAuth middleware
    res.status(200).json({ user: (req as Request & { user: unknown }).user });
  },

  async socialLogin(req: Request, res: Response): Promise<void> {
    const parsed = socialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { user, tokens, isNewUser } = await authService.socialLogin(parsed.data.idToken);
      res.status(isNewUser ? 201 : 200).json({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
