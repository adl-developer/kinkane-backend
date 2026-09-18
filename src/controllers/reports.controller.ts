import { Response } from 'express';
import { z } from 'zod';
import { reportsService } from '../services/reports.service';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const reasonSchema = z.string().trim().min(1).max(2000);

/**
 * A discriminated union, so a group report cannot carry a `reportedUserId` and
 * vice versa — the same shape the database CHECK enforces.
 *
 * `targetType` defaults to `'user'` when absent, so clients shipped before
 * groups were reportable keep working unchanged.
 */
const submitSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null && !('targetType' in v) ? { ...v, targetType: 'user' } : v),
  z.discriminatedUnion('targetType', [
    z.object({
      targetType: z.literal('user'),
      reportedUserId: z.number().int().positive(),
      reason: reasonSchema,
      postId: z.number().int().positive().optional(),
    }),
    // .strict() on this branch only. Zod otherwise strips unknown keys, so a
    // request naming BOTH a group and a user would quietly be filed as a group
    // report — a guess at an ambiguous intent. The user branch stays permissive
    // because clients already in the wild post to it.
    z.object({
      targetType: z.literal('group'),
      reportedGroupId: z.number().int().positive(),
      reason: reasonSchema,
    }).strict(),
  ]),
);

export const reportsController = {
  async submit(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    try {
      const report = await reportsService.create({ ...parsed.data, reporterId: req.user.id });
      res.status(201).json({ report });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
