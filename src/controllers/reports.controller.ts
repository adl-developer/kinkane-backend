import { Response } from 'express';
import { z } from 'zod';
import { reportsService } from '../services/reports.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const submitSchema = z.object({
  reportedUserId: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
  postId: z.number().int().positive().optional(),
});

export const reportsController = {
  async submit(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const report = await reportsService.create(
        req.user.id,
        parsed.data.reportedUserId,
        parsed.data.reason,
        parsed.data.postId,
      );
      res.status(201).json({ report });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
