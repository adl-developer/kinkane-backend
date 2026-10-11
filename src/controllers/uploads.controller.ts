import { Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { uploadsService } from '../services/uploads.service';

const signatureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('upload') }),
  z.object({ kind: z.literal('group'), groupId: z.number().int().positive() }),
]);

export const uploadsController = {
  /** Mounted with wrapHttp: the service's 404/503 come back with their `code`. */
  async createSignature(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = signatureSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const result = await uploadsService.createSignature(req.user.id, parsed.data);
    res.status(200).json(result);
  },
};
