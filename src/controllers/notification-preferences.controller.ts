import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { notificationPreferencesService } from '../services/notification-preferences.service';
import { logger } from '../lib/logger';

const updateSchema = z
  .object({
    newBookSuggestions: z.boolean().optional(),
    rateReviewReminders: z.boolean().optional(),
    friendRequests: z.boolean().optional(),
    comments: z.boolean().optional(),
    likes: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'At least one preference must be provided',
  });

function formatPrefs(row: Awaited<ReturnType<typeof notificationPreferencesService.get>>) {
  return {
    newBookSuggestions: row.newBookSuggestions,
    rateReviewReminders: row.rateReviewReminders,
    friendRequests: row.friendRequests,
    comments: row.comments,
    likes: row.likes,
  };
}

export const notificationPreferencesController = {
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const prefs = await notificationPreferencesService.get(req.user.id);
      res.status(200).json({ notificationPreferences: formatPrefs(prefs) });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      logger.error('Unexpected error fetching notification preferences', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const prefs = await notificationPreferencesService.update(req.user.id, parsed.data);
      res.status(200).json({ notificationPreferences: formatPrefs(prefs) });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      logger.error('Unexpected error updating notification preferences', { error: e.message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
