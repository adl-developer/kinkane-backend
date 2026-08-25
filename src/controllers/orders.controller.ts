import { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { ordersService } from '../services/commerce/orders.service';
import { parseId } from '../lib/route-helpers';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  // The order UI's filter tabs. 'pending' and 'closed' are accepted but cannot
  // widen the result set — see list() in orders.service.
  status: z.enum(['in_progress', 'delivered', 'closed']).optional(),
});

/**
 * Reference plus token. Both bounded before anything touches the database:
 * these are the only unauthenticated order endpoints, so they take the
 * narrowest input the format allows.
 */
const guestOrderSchema = z.object({
  reference: z.string().trim().regex(/^ORD-[0-9A-HJKMNP-TV-Z]{8}$/i, 'Invalid order reference'),
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid access token'),
});

export const ordersController = {
  /** GET /api/v1/orders */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const orders = await ordersService.list(
      req.user.id,
      parsed.data.limit,
      parsed.data.offset,
      parsed.data.status,
    );
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

  /**
   * POST /api/v1/orders/lookup
   *
   * "Track My Order" for someone with no account. Unauthenticated by design and
   * rate limited hard.
   *
   * An unknown reference and a wrong token are the same 404 with the same body,
   * so this cannot be turned into an oracle for which references exist.
   */
  async lookup(req: Request, res: Response): Promise<void> {
    const parsed = guestOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const order = await ordersService.findByReferenceAndToken(
      parsed.data.reference,
      parsed.data.token,
    );

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.status(200).json(order);
  },

  /**
   * POST /api/v1/orders/claim
   *
   * Attaches a guest order to the signed-in account — the "Save your order
   * details" step after checkout. Requires auth: there has to be an account to
   * attach it *to*, and the account comes from the bearer token, never the body.
   *
   * 404 covers unknown reference, wrong token, and already-claimed alike. An
   * order that already has an owner is not the caller's business to distinguish.
   */
  async claim(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = guestOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const order = await ordersService.claim(
      parsed.data.reference,
      parsed.data.token,
      req.user.id,
    );

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    res.status(200).json(order);
  },
};
