import { Request, Response } from 'express';
import { shopCurrency } from './books.controller';
import { z } from 'zod';
import { booksService } from '../services/books.service';
import {
  bestsellersService,
  BESTSELLER_WINDOWS,
} from '../services/commerce/bestsellers.service';
import { logger } from '../lib/logger';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

// There is no `shoppable` parameter on these feeds any more. Every surface they
// appear on has an Add button, so they only ever return books the shop can sell
// and every row always carries the live price and stock. It was a flag a client
// had to know to send, and forgetting it produced exactly the feed nobody
// wanted: books that cannot be bought, with no price on them. A stray
// `?shoppable=` is ignored rather than rejected, so an older client keeps
// working and gets what it was asking for anyway.
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
   * sales data of any kind. Falls back to trending when nothing sold in the
   * window, flagged by `source: 'trending'` on the response.
   *
   * Books the shop cannot sell never appear, and every row carries the live
   * price and stock — on the trending fallback as well as the chart. This
   * endpoint once documented a `shoppable` flag it never actually parsed, so
   * the shop fields the spec promised were silently absent; there is no flag to
   * get wrong now.
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
      // a book someone swiped away is still a book other people bought. The
      // trending fallback inherits that and stays unpersonalised too, so one
      // response can be described to every caller the same way.
      const result = await bestsellersService.list(
        parsed.data.window,
        parsed.data.limit,
        await shopCurrency(req),
      );
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
      const books = await booksService.trending(
        parsed.data.limit,
        userId,
        await shopCurrency(req),
      );
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
      const books = await booksService.personalized(
        user.id,
        parsed.data.limit,
        await shopCurrency(req),
      );
      res.status(200).json({ books });
    } catch (err: unknown) {
      logger.error('Unexpected error fetching personalized books', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
