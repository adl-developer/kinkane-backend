import { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { savedBooksService } from '../services/saved-books.service';
import { resolveRequestCountry } from '../services/commerce/pricing';
import { parseId } from '../lib/route-helpers';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  currency: z.string().length(3).optional(),
});

const addSchema = z.object({
  bookId: z.coerce.number().int().positive(),
});

export const savedBooksController = {
  /** GET /api/v1/saved-books */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await savedBooksService.list(req.user.id, {
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      currency: parsed.data.currency,
      countryCode: await resolveRequestCountry(req),
    });

    res.status(200).json(result);
  },

  /** POST /api/v1/saved-books */
  async add(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await savedBooksService.add(req.user.id, parsed.data.bookId);
    res.status(200).json(result);
  },

  /** DELETE /api/v1/saved-books/:bookId */
  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    const bookId = parseId(req.params.bookId, 'book id');
    const result = await savedBooksService.remove(req.user.id, bookId);
    res.status(200).json(result);
  },
};
