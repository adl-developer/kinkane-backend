import { Response } from 'express';
import { z } from 'zod';
import { usersService } from '../services/users.service';
import { parseId } from '../lib/route-helpers';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const shelfQuerySchema = z.object({
  filter: z.enum(['all', 'want_to_read', 'reading', 'read']).default('all'),
  sort:   z.enum(['date_desc', 'date_asc', 'title_asc', 'title_desc']).default('date_desc'),
  limit:  z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const followGraphQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const usersController = {
  async getUserProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const targetId = parseId(req.params.userId, 'user ID');
      const profile = await usersService.getUserProfile(targetId, req.user.id);
      res.status(200).json(profile);
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async listPendingFollowRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = followGraphQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const { limit, offset } = parsed.data;
      const result = await usersService.listPendingFollowRequests(req.user.id, limit, offset);
      res.status(200).json({ ...result, limit, offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async sendFollowRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const receiverId = parseId(req.params.userId, 'user ID');
      await usersService.sendFollowRequest(req.user.id, receiverId);
      res.status(201).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async withdrawFollowRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const receiverId = parseId(req.params.userId, 'user ID');
      await usersService.withdrawFollowRequest(req.user.id, receiverId);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async acceptFollowRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const requestId = parseId(req.params.requestId, 'request ID');
      await usersService.acceptFollowRequest(requestId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async declineFollowRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const requestId = parseId(req.params.requestId, 'request ID');
      await usersService.declineFollowRequest(requestId, req.user.id);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async listFollowers(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = followGraphQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const targetId = parseId(req.params.userId, 'user ID');
      const { limit, offset } = parsed.data;
      const result = await usersService.listFollowers(targetId, req.user.id, limit, offset);
      res.status(200).json({ ...result, limit, offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async listFollowing(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = followGraphQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const targetId = parseId(req.params.userId, 'user ID');
      const { limit, offset } = parsed.data;
      const result = await usersService.listFollowing(targetId, req.user.id, limit, offset);
      res.status(200).json({ ...result, limit, offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },

  async getUserBooks(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = shelfQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    try {
      const targetId = parseId(req.params.userId, 'user ID');
      const { filter, sort, limit, offset } = parsed.data;
      const result = await usersService.getUserBooks(targetId, req.user.id, filter, sort, limit, offset);
      res.status(200).json({ ...result, filter, sort, limit, offset });
    } catch (err: unknown) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
