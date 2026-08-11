import { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { cartService } from '../services/commerce/cart.service';
import { commerceCheckoutService } from '../services/commerce/checkout.service';
import { resolveRequestCountry } from '../services/commerce/pricing';
import { config } from '../config';

const viewSchema = z.object({
  // Lets a client override the currency the cart is priced in — a user in a
  // country whose currency we don't support may still prefer GBP to the USD
  // default. Ignored if unsupported (see resolveCurrency).
  currency: z.string().length(3).optional(),
});

const addSchema = z.object({
  bookId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(config.commerce.cart.maxQuantityPerLine).default(1),
});

const quantitySchema = z.object({
  // Zero is meaningful: it removes the line, so a stepper clicked down to
  // nothing behaves the way the user expects without a separate call.
  quantity: z.coerce.number().int().min(0).max(config.commerce.cart.maxQuantityPerLine),
});

const checkoutSchema = z.object({
  // Required, and asked for *before* Stripe. Shipping and tax are both priced
  // off this, and Stripe only collects an address after the price is fixed.
  shippingCountry: z.string().length(2),
  currency: z.string().length(3).optional(),
});

export const cartController = {
  /** GET /api/v1/cart */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = viewSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const cart = await cartService.view(req.user.id, {
      currency: parsed.data.currency,
      countryCode: await resolveRequestCountry(req),
    });

    res.status(200).json(cart);
  },

  /** POST /api/v1/cart/items */
  async addItem(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const item = await cartService.addItem(
      req.user.id,
      parsed.data.bookId,
      parsed.data.quantity,
      await resolveRequestCountry(req),
    );

    res.status(200).json(item);
  },

  /** PATCH /api/v1/cart/items/:bookId */
  async setQuantity(req: AuthenticatedRequest, res: Response): Promise<void> {
    const bookId = Number(req.params.bookId);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      res.status(400).json({ error: 'Invalid book id' });
      return;
    }

    const parsed = quantitySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const item = await cartService.setQuantity(
      req.user.id,
      bookId,
      parsed.data.quantity,
      await resolveRequestCountry(req),
    );

    res.status(200).json(item ?? { removed: true });
  },

  /** DELETE /api/v1/cart/items/:bookId */
  async removeItem(req: AuthenticatedRequest, res: Response): Promise<void> {
    const bookId = Number(req.params.bookId);
    if (!Number.isInteger(bookId) || bookId <= 0) {
      res.status(400).json({ error: 'Invalid book id' });
      return;
    }

    await cartService.removeItem(req.user.id, bookId);
    res.status(200).json({ success: true });
  },

  /** DELETE /api/v1/cart */
  async clear(req: AuthenticatedRequest, res: Response): Promise<void> {
    const removed = await cartService.clear(req.user.id);
    res.status(200).json({ removed });
  },

  /**
   * POST /api/v1/cart/checkout
   *
   * A 409 here is the normal, expected path when a price or stock level moved:
   * the body carries `changes`, the cart has already been repaired, and the
   * client's job is to show the user what changed and let them press the button
   * again.
   */
  async checkout(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const result = await commerceCheckoutService.start(req.user.id, {
      destinationCountry: parsed.data.shippingCountry,
      currency: parsed.data.currency,
    });

    res.status(200).json(result);
  },
};
