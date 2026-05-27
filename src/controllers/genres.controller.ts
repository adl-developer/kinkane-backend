import { Request, Response } from 'express';
import { genresService } from '../services/genres.service';

export const genresController = {
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const results = await genresService.list();
      res.status(200).json({ genres: results });
    } catch (err: unknown) {
      const e = err as Error;
      res.status(500).json({ error: e.message });
    }
  },
};
