import { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { cartService } from '../services/commerce/cart.service';
import { commerceCheckoutService } from '../services/commerce/checkout.service';
import { resolveRequestCountry } from '../services/commerce/pricing';
import { phoneSchema } from '../lib/phone';
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

/**
 * Lengths mirror the column widths in `orders` exactly. Validating here rather
 * than relying on the database to truncate means an over-long field is a 400
 * the buyer can fix, not a silently clipped address a parcel gets sent to.
 */
const shippingAddressSchema = z.object({
  name: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(1).max(200),
  region: z.string().trim().max(200).optional().nullable(),
  postcode: z.string().trim().min(1).max(32),
  countryCode: z.string().trim().length(2),
});

/**
 * A client-held basket line. Book id and quantity only — deliberately no price
 * field, so there is nothing for a caller to try to influence. Bounds are here
 * as well as in the service because this is reachable without an account.
 */
const requestedLineSchema = z.object({
  bookId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(config.commerce.cart.maxQuantityPerLine),
});

const priceSchema = z.object({
  lines: z.array(requestedLineSchema).max(config.commerce.cart.maxItems),
  currency: z.string().length(3).optional(),
});

/**
 * A basket plus a destination, for pricing delivery options before checkout.
 * The country is required — the whole point is asking about a specific place,
 * and guessing from the request's IP would quote one country and charge for
 * another.
 */
const shippingOptionsSchema = z.object({
  countryCode: z.string().trim().length(2),
  currency: z.string().length(3).optional(),
  // Guests send their basket; a signed-in buyer's stored cart is used when this
  // is omitted, matching how checkout already behaves.
  lines: z.array(requestedLineSchema).max(config.commerce.cart.maxItems).optional(),
});

const checkoutSchema = z.object({
  // Still accepted for the older flow, where Stripe collects the address and
  // its collection is locked to this country. Optional now: when a full
  // `shippingAddress` is supplied, its own countryCode is the destination and
  // there is no second country to disagree with.
  shippingCountry: z.string().length(2).optional(),
  currency: z.string().length(3).optional(),
  shippingAddress: shippingAddressSchema.optional(),
  // Guests only. Ignored for a signed-in buyer, whose account email wins — see
  // the note in checkout.service.start.
  contactEmail: z.string().trim().email().max(254).optional(),
  // Delivery contact number, taken from whoever is checking out. Unlike
  // contactEmail this *is* honoured for a signed-in buyer: a phone number is
  // not an identity, and someone shipping a present to a friend should be able
  // to give the recipient's number without editing their own profile.
  contactPhone: phoneSchema.optional(),
  /**
   * The delivery service the buyer picked, from POST /cart/shipping-options.
   * Optional: a client that never showed a chooser gets the cheapest available
   * service rather than being silently upgraded onto the expensive one.
   *
   * Only the code is accepted, never a price — the server re-prices it.
   */
  shippingServiceCode: z.string().trim().regex(/^\d{3}$/).optional(),
  // Guests only — a signed-in buyer's stored cart is authoritative.
  lines: z.array(requestedLineSchema).max(config.commerce.cart.maxItems).optional(),
}).refine((v) => Boolean(v.shippingCountry || v.shippingAddress), {
  message: 'Either shippingCountry or shippingAddress is required',
  path: ['shippingCountry'],
});

export const cartController = {
  /**
   * POST /api/v1/cart/price
   *
   * Prices a basket the client is holding, and stores nothing. This is how a
   * visitor with no account sees live prices, stock and sale badges before
   * signing in — there is no cart row, no token and no record of anyone who
   * never signs up.
   *
   * Works signed-in too, for a client that wants to price a basket without
   * mutating the stored cart.
   */
  async price(req: Request, res: Response): Promise<void> {
    const parsed = priceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const basket = await cartService.priceBasket(parsed.data.lines, {
      currency: parsed.data.currency,
      countryCode: await resolveRequestCountry(req),
    });

    res.status(200).json(basket);
  },

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
  async checkout(req: Request, res: Response): Promise<void> {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    // optionalAuth: a signed-in buyer checks out their stored cart, a guest
    // sends their basket. `req.user` is absent for the latter.
    const userId = (req as AuthenticatedRequest).user?.id ?? null;

    if (userId === null && !parsed.data.lines?.length) {
      res.status(400).json({
        error: 'Send your basket as `lines` to check out without an account',
        code: 'LINES_REQUIRED',
      });
      return;
    }

    const result = await commerceCheckoutService.start(userId, {
      destinationCountry:
        parsed.data.shippingAddress?.countryCode ?? parsed.data.shippingCountry ?? '',
      currency: parsed.data.currency,
      address: parsed.data.shippingAddress,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      shippingServiceCode: parsed.data.shippingServiceCode,
      lines: parsed.data.lines,
    });

    res.status(200).json(result);
  },

  /**
   * POST /api/v1/cart/shipping-options
   *
   * What delivery this basket can have to this country, and what each costs.
   *
   * Prices nothing else and stores nothing. An empty `options` array is a real
   * answer, not an error: some destinations Gardners will address have no
   * published rate, and the cart needs to say so before someone reaches
   * checkout and is refused.
   */
  async shippingOptions(req: Request, res: Response): Promise<void> {
    const parsed = shippingOptionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const userId = (req as AuthenticatedRequest).user?.id ?? null;
    const result = await commerceCheckoutService.shippingOptions(userId, {
      countryCode: parsed.data.countryCode,
      currency: parsed.data.currency,
      lines: parsed.data.lines,
    });

    res.status(200).json(result);
  },
};
