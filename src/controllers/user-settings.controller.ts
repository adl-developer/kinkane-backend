import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { userSettingsService } from '../services/user-settings.service';

import { logger } from '../lib/logger';

const shelfVisibilitySchema = z.object({
  visibility: z.enum(['public', 'friends', 'private']),
});

export const userSettingsController = {
  async getUserSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const settings = await userSettingsService.getUserSettings(req.user.id);
      res.status(200).json({ settings });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      const status = e.statusCode ?? 500;
      if (status >= 500) {
        logger.error('Unexpected error fetching user settings', { error: e.message });
        res.status(500).json({ error: 'An unexpected error occurred' });
      } else {
        res.status(status).json({ error: e.message });
      }
    }
  },

  async updateShelfVisibility(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = shelfVisibilitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      await userSettingsService.updateShelfVisibility(req.user.id, parsed.data.visibility);
      res.status(200).json({ shelfVisibility: parsed.data.visibility });
    } catch (err: unknown) {
      const e = err as Error;
      logger.error('Unexpected error updating shelf visibility', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
