import { Request, Response } from 'express';
import { z } from 'zod';
import { booksService } from '../services/books.service';
import { logger } from '../lib/logger';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const limitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export const exploreController = {
  async getTrending(req: Request, res: Response): Promise<void> {
    const parsed = limitSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const books = await booksService.trending(parsed.data.limit);
      res.status(200).json({ books });
    } catch (err: unknown) {
      logger.error('Unexpected error fetching trending books', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  async getPersonalized(req: Request, res: Response): Promise<void> {
    const parsed = limitSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { user } = req as AuthenticatedRequest;

    try {
      const books = await booksService.personalized(user.id, parsed.data.limit);
      res.status(200).json({ books });
    } catch (err: unknown) {
      logger.error('Unexpected error fetching personalized books', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
