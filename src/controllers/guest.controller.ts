import { Request, Response } from 'express';
import { z } from 'zod';
import { guestService } from '../services/guest.service';
import { logger } from '../lib/logger';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const selectionsSchema = z.object({
  chosenBookIds: z
    .array(z.number().int().positive())
    .min(1, 'At least 1 book must be chosen')
    .max(5, 'A maximum of 5 books can be chosen'),
});

export const guestController = {
  /**
   * POST /api/v1/guest-sessions/:id/selections
   * Saves the 5 books the user chose from the recommendation results.
   */
  async saveSelections(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    if (!uuidRegex.test(id)) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const result = await guestService.saveSelections(id, parsed.data.chosenBookIds);
      if (!result) {
        res.status(404).json({ error: 'Session not found or expired' });
        return;
      }
      res.status(200).json({ readerType: result.readerType, books: result.books });
    } catch (err: unknown) {
      logger.error('Unexpected error saving selections', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },

  /**
   * GET /api/v1/guest-sessions/:id
   * Lets the client verify a stored UUID is still alive (e.g. on app resume).
   */
  async getById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    if (!uuidRegex.test(id)) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const session = await guestService.getById(id);
      if (!session) {
        res.status(404).json({ error: 'Session not found or expired' });
        return;
      }
      res.status(200).json({
        guestSessionId: session.id,
        displayName: session.displayName,
        expiresAt: session.expiresAt,
      });
    } catch (err: unknown) {
      logger.error('Unexpected error fetching guest session', { error: (err as Error).message });
      res.status(500).json({ error: 'An unexpected error occurred' });
    }
  },
};
