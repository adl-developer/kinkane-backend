import { Request, Response } from 'express';
import { z } from 'zod';
import { authorsService } from '../services/authors.service';
import { AUTHOR_SLUG_PATTERN } from '../lib/author-slug';

const slugSchema = z.string().trim().max(200).regex(AUTHOR_SLUG_PATTERN, 'Invalid author slug');

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const authorsController = {
  /** GET /api/v1/authors/:slug */
  async get(req: Request, res: Response): Promise<void> {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) {
      res.status(400).json({ error: 'Invalid author slug' });
      return;
    }

    const author = await authorsService.getBySlug(slug.data);
    if (!author) {
      res.status(404).json({ error: 'Author not found' });
      return;
    }

    res.status(200).json(author);
  },

  /** GET /api/v1/authors/:slug/books */
  async books(req: Request, res: Response): Promise<void> {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) {
      res.status(400).json({ error: 'Invalid author slug' });
      return;
    }

    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await authorsService.books(slug.data, parsed.data);
    // An author with no books is a 404 rather than an empty list — the slug
    // resolved to nobody, which is a wrong URL, not an empty shelf.
    if (result.total === 0) {
      res.status(404).json({ error: 'Author not found' });
      return;
    }

    res.status(200).json(result);
  },
};
