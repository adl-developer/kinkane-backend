import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { notificationsService } from '../services/notifications.service';
import { logger } from '../lib/logger';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const markReadSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(50),
});

export const notificationsController = {
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const { limit, offset } = parsed.data;
      const result = await notificationsService.list(req.user.id, limit, offset);
      res.status(200).json({ ...result, limit, offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      logger.error('Unexpected error fetching notifications', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  async markRead(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = markReadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await notificationsService.markRead(req.user.id, parsed.data.ids);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      logger.error('Unexpected error marking notifications read', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
