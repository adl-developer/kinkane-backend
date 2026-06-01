import { Request, Response } from 'express';
import { z } from 'zod';
import { booksService } from '../services/books.service';
import { userBooksService } from '../services/user-books.service';

const suggestionsSchema = z.object({
  q: z.string().min(2, 'Query must be at least 2 characters').max(100),
  limit: z.coerce.number().int().min(1).max(15).default(8),
});

const listSchema = z.object({
  q: z.string().min(1).max(200).optional(),
  author: z.string().min(1).max(200).optional(),
  genre: z.string().min(1).max(300).optional(),
  availability: z.string().length(2).optional(),
  productForm: z.string().min(1).max(10).optional(),
  publishingStatus: z.string().length(2).optional(),
  publisher: z.string().min(1).max(200).optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const booksController = {
  async suggestions(req: Request, res: Response): Promise<void> {
    const parsed = suggestionsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const results = await booksService.suggestions(parsed.data.q, parsed.data.limit);
      res.status(200).json({ suggestions: results });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  async list(req: Request, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const result = await booksService.list(parsed.data);
      res.status(200).json({
        books: result.books,
        total: result.total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },

  async getById(req: Request, res: Response): Promise<void> {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid book ID' });
      return;
    }

    try {
      // C1 + C2 fix: fetch the book first so the 404 check is never bypassed by
      // a getPublicNotes failure, and so we don't waste a DB/cache round-trip for
      // a non-existent book ID.
      const book = await booksService.getById(id);
      if (!book) {
        res.status(404).json({ error: 'Book not found' });
        return;
      }

      // C1 + C4 fix: public notes are a non-critical enhancement — a Redis or DB
      // failure here must not take down the entire book detail response.
      let publicNotes: Awaited<ReturnType<typeof userBooksService.getPublicNotes>> = [];
      try {
        publicNotes = await userBooksService.getPublicNotes(id);
      } catch {
        // degrade gracefully: return empty notes rather than a 500
      }

      res.status(200).json({ book, publicNotes });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },
};
