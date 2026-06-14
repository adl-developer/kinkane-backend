import { Request, Response } from 'express';
import { z } from 'zod';
import { emailChangeService } from '../services/email-change.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { logger } from '../lib/logger';

const requestSchema = z.object({
  newEmail: z.string().email('Invalid email address'),
});

const verifySchema = z.object({
  otp: z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
});

const cancelSchema = z.object({
  token: z.string().min(1, 'Cancellation token is required'),
});

function handleError(res: Response, err: unknown, context: string): void {
  const e = err as Error & { statusCode?: number };
  const status = e.statusCode ?? 500;
  if (status >= 500) {
    logger.error(`Unexpected error during ${context}`, { error: e.message });
    res.status(500).json({ error: 'An unexpected error occurred' });
  } else {
    res.status(status).json({ error: e.message });
  }
}

export const emailChangeController = {
  async requestChange(req: Request, res: Response): Promise<void> {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { id } = (req as AuthenticatedRequest).user;

    try {
      await emailChangeService.requestEmailChange(id, parsed.data.newEmail);
      res.status(200).json({
        message: 'A verification code has been sent to your new email address',
      });
    } catch (err) {
      handleError(res, err, 'email change request');
    }
  },

  async verifyChange(req: Request, res: Response): Promise<void> {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { id } = (req as AuthenticatedRequest).user;

    try {
      await emailChangeService.verifyEmailChange(id, parsed.data.otp);
      res.status(200).json({
        message: 'Email address updated successfully. Please log in again.',
      });
    } catch (err) {
      handleError(res, err, 'email change verification');
    }
  },

  async cancelChange(req: Request, res: Response): Promise<void> {
    const parsed = cancelSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await emailChangeService.cancelEmailChange(parsed.data.token);
      res.status(200).json({ message: 'Email change cancelled successfully' });
    } catch (err) {
      handleError(res, err, 'email change cancellation');
    }
  },

  async resendOtp(req: Request, res: Response): Promise<void> {
    const { id } = (req as AuthenticatedRequest).user;

    try {
      await emailChangeService.resendOtp(id);
      res.status(200).json({ message: 'A new verification code has been sent' });
    } catch (err) {
      handleError(res, err, 'OTP resend');
    }
  },
};
