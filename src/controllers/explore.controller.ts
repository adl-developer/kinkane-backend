import { Request, Response } from 'express';
import { z } from 'zod';
import { booksService } from '../services/books.service';
import {
  bestsellersService,
  BESTSELLER_WINDOWS,
} from '../services/commerce/bestsellers.service';
import { logger } from '../lib/logger';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const limitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

const bestsellersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  window: z.enum(BESTSELLER_WINDOWS).default('30d'),
});

export const exploreController = {
  /**
   * GET /api/v1/explore/bestsellers
   *
   * Ranked by copies actually sold, from our own orders — Gardners supplies no
   * sales data of any kind. Returns an empty list when nothing has sold in the
   * window, rather than substituting another feed.
   */
  async getBestsellers(req: Request, res: Response): Promise<void> {
    const parsed = bestsellersSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      // No viewer-specific filtering: this is a factual sales ranking, the same
      // for everybody. Unlike trending, there is nothing to exclude per user —
      // a book someone swiped away is still a book other people bought.
      const result = await bestsellersService.list(parsed.data.window, parsed.data.limit);
      res.status(200).json(result);
    } catch (err: unknown) {
      logger.error('Unexpected error fetching bestsellers', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  async getTrending(req: Request, res: Response): Promise<void> {
    const parsed = limitSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      // optionalAuth route — anonymous callers have no rejection history, and
      // signed-in ones get their rejected books filtered out of the shared list.
      const userId = (req as Partial<AuthenticatedRequest>).user?.id;
      const books = await booksService.trending(parsed.data.limit, userId);
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
