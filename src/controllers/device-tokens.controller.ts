import { Response } from 'express';
import { z } from 'zod';
import { deviceTokensService } from '../services/device-tokens.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const registerSchema = z.object({
  fcmToken: z.string().min(1).max(4096),
  platform: z.enum(['ios', 'android']),
});

const fcmTokenParam = z.string().min(1).max(4096);

export const deviceTokensController = {
  async register(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await deviceTokensService.register(req.user.id, parsed.data.fcmToken, parsed.data.platform);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async unregister(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = fcmTokenParam.safeParse(req.params.fcmToken);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid FCM token' });
      return;
    }

    try {
      await deviceTokensService.unregister(req.user.id, parsed.data);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
