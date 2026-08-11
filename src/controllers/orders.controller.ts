import { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ordersService } from '../services/commerce/orders.service';
import { parseId } from '../lib/route-helpers';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const ordersController = {
  /** GET /api/v1/orders */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const orders = await ordersService.list(req.user.id, parsed.data.limit, parsed.data.offset);
    res.status(200).json({ orders });
  },

  /**
   * GET /api/v1/orders/:id
   *
   * Scoped to the owner, and a miss is a 404 rather than a 403 — telling a
   * stranger that order 812 exists but isn't theirs is more than they need to
   * know.
   */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const orderId = parseId(req.params.id, 'order id');
    const order = await ordersService.get(req.user.id, orderId);

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.status(200).json(order);
  },
};
