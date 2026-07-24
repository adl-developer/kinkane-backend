import { Request, Response } from 'express';
import { z } from 'zod';
import { gardnersDropshipOrderService } from '../services/gardners-dropship/order.service';
import { parseId } from '../lib/route-helpers';
import { logger } from '../lib/logger';

const addressSchema = z.object({
  titleName: z.string().max(10).optional(),
  initials: z.string().max(3).optional(),
  name: z.string().min(1).max(35),
  addr1: z.string().min(1).max(35),
  addr2: z.string().max(35).optional(),
  addr3: z.string().max(35).optional(),
  addr4: z.string().max(35).optional(),
  postcode: z.string().max(8).optional(),
  country: z.string().min(1).max(60),
});

const lineSchema = z.object({
  isbn13: z.string().regex(/^\d{13}$/),
  quantity: z.coerce.number().int().min(1).max(9999),
  additionalReference: z.string().max(15).optional(),
  priceGbpPence: z.coerce.number().int().min(0),
  deliveryGbpPence: z.coerce.number().int().min(0).optional(),
  serviceCode: z.string().max(3).optional(),
  tracking: z.boolean().optional(),
  trackingEmail: z.string().email(),
  trackingSms: z.string().max(20).optional(),
  trackingSafePlace: z.string().max(24).optional(),
  comm1: z.string().max(60).optional(),
  invoice: addressSchema,
  delivery: addressSchema.optional(),
  batchRef: z.string().max(15).optional(),
  maxWaitDays: z.coerce.number().int().min(1).max(90).optional(),
});

const createOrderSchema = z.object({
  testing: z.boolean().optional(),
  lines: z.array(lineSchema).min(1),
});

export const gardnersDropshipController = {
  /**
   * POST /admin/gardners/dropship/orders
   * Body: { testing?: boolean, lines: [...] } — see CreateOrderInput.
   * Creates the order + line rows and immediately submits the .ORD file to
   * Gardners' HOMEORD. Responds 201 with the order and its lines.
   */
  async create(req: Request, res: Response): Promise<void> {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const result = await gardnersDropshipOrderService.createAndSubmit(parsed.data);
      res.status(201).json(result);
    } catch (err) {
      const e = err as Error;
      logger.error('Gardners dropship order creation failed', { error: e.message });
      res.status(500).json({ error: e.message });
    }
  },

  /**
   * GET /admin/gardners/dropship/orders/:id
   * Returns the current DB state of an order and its lines.
   */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const id = parseId(req.params.id, 'order id');
      const result = await gardnersDropshipOrderService.getOrder(id);
      res.status(200).json(result);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 404).json({ error: e.message });
    }
  },

  /**
   * POST /admin/gardners/dropship/orders/:id/poll-ack
   * Checks HOMEACK for this order's .ACK file. Safe to call repeatedly —
   * returns { status: 'not_ready' } until Gardners has processed the order.
   */
  async pollAck(req: Request, res: Response): Promise<void> {
    try {
      const id = parseId(req.params.id, 'order id');
      const outcome = await gardnersDropshipOrderService.pollAck(id);
      res.status(200).json(outcome);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      res.status(e.statusCode ?? 500).json({ error: e.message });
    }
  },
};
