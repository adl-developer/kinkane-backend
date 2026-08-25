/**
 * The shopping cart.
 *
 * Two things shape every method here:
 *
 * 1. **The cart stores intent, not a quotation.** Quantities and book ids are
 *    durable; prices are not. Every read re-prices against the live Gardners
 *    feed and reports what moved since the line was added. The stored
 *    `unit_price_gbp_pence` exists only so that "what moved" is answerable.
 *
 * 2. **Restrictions are checked twice, against different countries.** Here, the
 *    check uses the viewer's *apparent* country (a header), because that is all
 *    we know before checkout — it is a courtesy check, catching the common case
 *    early. The binding one is at checkout, against the destination the buyer
 *    actually types in. A VPN can defeat the first; it cannot defeat the second.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { carts, cartItems, type Cart } from '../../db/schema';
import { config } from '../../config';
import { availabilityService, unbuyableResponse, type BuyableBook } from './availability.service';
import { quoteShipping, resolveCurrency, toPresentment } from './pricing';

export interface CartLineView {
  bookId: number;
  isbn13: string;
  title: string;
  contributor: string | null;
  coverUrl: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  unitPriceGbpPence: number;
  /**
   * The struck-through "was" price in presentment currency, or null when this
   * line is not on sale. Comes from the same availability check that sets
   * `unitPriceMinor`, so the badge and the amount charged are computed from one
   * source and cannot disagree.
   */
  compareAtMinor: number | null;
  lineTotalGbpPence: number;
  /** True when the live price differs from the one captured at add time. */
  priceChanged: boolean;
  previousUnitPriceMinor: number | null;
  /** True when the line can no longer be bought at all — out of stock, etc. */
  unavailable: boolean;
  unavailableReason: string | null;
  /** Live stock, so the client can cap the quantity stepper. */
  stockQty: number | null;
  /**
   * Not stocked, but orderable. Show "available to order", not an out-of-stock
   * badge — and expect a longer lead time than a stocked title.
   */
  supplyToOrder: boolean;
}

export interface CartView {
  cartId: number;
  currency: string;
  lines: CartLineView[];
  subtotalMinor: number;
  /** Indicative only — the binding figure needs a destination, so it is quoted at checkout. */
  estimatedShippingMinor: number | null;
  totalMinor: number;
  itemCount: number;
  hasIssues: boolean;
}

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

/** One line of a client-held basket, as submitted for pricing or checkout. */
export interface RequestedLine {
  bookId: number;
  quantity: number;
}

export interface PricedLine {
  bookId: number;
  isbn13: string | null;
  title: string | null;
  contributor: string | null;
  coverUrl: string | null;
  /** What the buyer asked for. */
  quantity: number;
  /**
   * How many of those can actually be supplied — `min(requested, stock)`.
   *
   * Deliberately capped at what was asked for rather than reporting the real
   * stock level. This endpoint is public, and Gardners' inventory depth is
   * commercial information that is not ours to publish. Capping still tells the
   * buyer everything they need ("you can have 2 of the 5 you wanted") while
   * revealing nothing about the shelf behind it.
   */
  availableQuantity: number;
  /** Not stocked, but orderable. See CartLineView.supplyToOrder. */
  supplyToOrder: boolean;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  /** Struck-through "was" price, or null when not on sale. */
  compareAtMinor: number | null;
  unavailable: boolean;
  unavailableReason: string | null;
}

export interface PricedBasket {
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  estimatedShippingMinor: number | null;
  totalMinor: number;
  itemCount: number;
  hasIssues: boolean;
}

export const cartService = {
  /**
   * Prices a basket the client is holding, storing nothing.
   *
   * Before sign-in the basket lives entirely on the client, so this is how it
   * gets rendered with live prices, live stock and sale badges. It is a pure
   * read: no cart row, no token, no trace of anyone who never signs up.
   *
   * **Every figure here is computed from our own data.** The request supplies
   * book ids and quantities and nothing else — no prices are read from it, and
   * any that were sent would be ignored. That is the same rule checkout
   * enforces, which is what lets an unauthenticated caller price a basket
   * without being able to influence what it costs.
   */
  async priceBasket(
    requested: RequestedLine[],
    options: { currency?: string | null; countryCode?: string | null },
  ): Promise<PricedBasket> {
    const currency = resolveCurrency({
      requested: options.currency,
      countryCode: options.countryCode,
    });

    // Collapse repeats rather than rejecting them: a client that sends the same
    // book twice means "three of these", not an error. Caps are applied after
    // merging so two lines of 8 cannot smuggle 16 past a limit of 10.
    const merged = new Map<number, number>();
    for (const line of requested) {
      const total = (merged.get(line.bookId) ?? 0) + line.quantity;
      merged.set(line.bookId, Math.min(total, config.commerce.cart.maxQuantityPerLine));
    }

    if (merged.size === 0) {
      return {
        currency,
        lines: [],
        subtotalMinor: 0,
        estimatedShippingMinor: null,
        totalMinor: 0,
        itemCount: 0,
        hasIssues: false,
      };
    }

    const { buyable, rejected } = await availabilityService.check(
      [...merged.keys()],
      options.countryCode ?? '',
    );

    const lines: PricedLine[] = [...merged.entries()].map(([bookId, quantity]) => {
      const live = buyable.get(bookId);
      const reason = live ? null : (rejected.get(bookId) ?? 'not_found');
      const availableQuantity = live ? Math.min(quantity, live.orderableQuantity) : 0;

      return {
        bookId,
        isbn13: live?.isbn13 ?? null,
        title: live?.title ?? null,
        contributor: live?.contributor ?? null,
        coverUrl: live?.coverUrl ?? null,
        quantity,
        availableQuantity,
        supplyToOrder: live?.supplyToOrder ?? false,
        unitPriceMinor: live ? toPresentment(live.unitPriceGbpPence, currency) : null,
        // Priced on what can actually be supplied, not on what was asked for —
        // a total that includes two copies we cannot ship is a surprise waiting
        // to happen at checkout.
        lineTotalMinor: live
          ? toPresentment(live.unitPriceGbpPence * availableQuantity, currency)
          : null,
        compareAtMinor:
          live?.compareAtGbpPence != null
            ? toPresentment(live.compareAtGbpPence, currency)
            : null,
        unavailable: Boolean(reason) || availableQuantity === 0,
        unavailableReason: reason,
      };
    });

    const sellable = lines.filter((line) => !line.unavailable);
    const subtotalMinor = sellable.reduce((sum, line) => sum + (line.lineTotalMinor ?? 0), 0);
    const itemCount = sellable.reduce((sum, line) => sum + line.availableQuantity, 0);

    const subtotalGbpPence = [...merged.entries()].reduce((sum, [bookId, quantity]) => {
      const live = buyable.get(bookId);
      if (!live) return sum;
      return sum + live.unitPriceGbpPence * Math.min(quantity, live.orderableQuantity);
    }, 0);

    let estimatedShippingMinor: number | null = null;
    if (options.countryCode && itemCount > 0) {
      try {
        const shipping = quoteShipping({
          countryCode: options.countryCode,
          itemCount,
          subtotalGbpPence,
        });
        estimatedShippingMinor = toPresentment(shipping.gbpPence, currency);
      } catch {
        estimatedShippingMinor = null;
      }
    }

    return {
      currency,
      lines,
      subtotalMinor,
      estimatedShippingMinor,
      totalMinor: subtotalMinor + (estimatedShippingMinor ?? 0),
      itemCount,
      hasIssues: lines.some((line) => line.unavailable || line.availableQuantity < line.quantity),
    };
  },

  /**
   * Returns the user's open cart, creating one if they have none.
   *
   * The insert races against itself whenever someone double-taps add-to-cart:
   * both requests see no cart and both insert. The partial unique index on
   * (user_id) WHERE status='active' turns the loser into a no-op rather than a
   * second cart, and the follow-up select picks up the winner's row.
   */
  async getOrCreate(userId: number): Promise<Cart> {
    const active = and(eq(carts.userId, userId), eq(carts.status, 'active'));
    const [existing] = await db.select().from(carts).where(active).limit(1);

    if (existing) return existing;

    const [created] = await db
      .insert(carts)
      .values({ userId, status: 'active' })
      .onConflictDoNothing()
      .returning();

    if (created) return created;

    const [winner] = await db.select().from(carts).where(active).limit(1);

    if (!winner) {
      throw httpError('Could not open a cart', 500);
    }
    return winner;
  },

  /**
   * The cart as the client should render it: live prices, live stock, and a
   * per-line flag for anything that changed underneath the user.
   */
  async view(
    userId: number,
    options: { currency?: string | null; countryCode?: string | null },
  ): Promise<CartView> {
    const cart = await this.getOrCreate(userId);
    const currency = resolveCurrency({
      requested: options.currency,
      countryCode: options.countryCode,
    });

    const items = await db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cart.id))
      .orderBy(cartItems.createdAt);

    if (items.length === 0) {
      return {
        cartId: cart.id,
        currency,
        lines: [],
        subtotalMinor: 0,
        estimatedShippingMinor: null,
        totalMinor: 0,
        itemCount: 0,
        hasIssues: false,
      };
    }

    const { buyable, rejected } = await availabilityService.check(
      items.map((item) => item.bookId),
      options.countryCode ?? '',
    );

    const lines: CartLineView[] = items.map((item) => {
      const live = buyable.get(item.bookId);
      const reason = rejected.get(item.bookId) ?? null;

      // An unavailable line keeps its captured price so the row still renders
      // with the number the user last saw, rather than collapsing to zero.
      const unitPriceGbpPence = live?.unitPriceGbpPence ?? item.unitPriceGbpPence;
      const lineTotalGbpPence = unitPriceGbpPence * item.quantity;
      const priceChanged = Boolean(live) && live!.unitPriceGbpPence !== item.unitPriceGbpPence;

      return {
        bookId: item.bookId,
        isbn13: item.isbn13,
        title: live?.title ?? '',
        contributor: live?.contributor ?? null,
        coverUrl: live?.coverUrl ?? null,
        quantity: item.quantity,
        unitPriceMinor: toPresentment(unitPriceGbpPence, currency),
        lineTotalMinor: toPresentment(lineTotalGbpPence, currency),
        unitPriceGbpPence,
        lineTotalGbpPence,
        compareAtMinor:
          live?.compareAtGbpPence != null ? toPresentment(live.compareAtGbpPence, currency) : null,
        priceChanged,
        previousUnitPriceMinor: priceChanged
          ? toPresentment(item.unitPriceGbpPence, currency)
          : null,
        unavailable: Boolean(reason),
        unavailableReason: reason,
        stockQty: live?.stockQty ?? null,
        supplyToOrder: live?.supplyToOrder ?? false,
      };
    });

    // Totals count only what can actually be bought — showing a total that
    // includes an out-of-stock line sets up a nasty surprise at checkout.
    const sellable = lines.filter((line) => !line.unavailable);
    const subtotalMinor = sellable.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    const subtotalGbpPence = sellable.reduce((sum, line) => sum + line.lineTotalGbpPence, 0);
    const itemCount = sellable.reduce((sum, line) => sum + line.quantity, 0);

    // Indicative shipping, quoted against the viewer's apparent country. Null
    // when we have no idea where they are: an estimate pulled from thin air is
    // worse than admitting we cannot give one yet.
    let estimatedShippingMinor: number | null = null;
    if (options.countryCode && itemCount > 0) {
      try {
        const shipping = quoteShipping({
          countryCode: options.countryCode,
          itemCount,
          subtotalGbpPence,
        });
        estimatedShippingMinor = toPresentment(shipping.gbpPence, currency);
      } catch {
        estimatedShippingMinor = null;
      }
    }

    return {
      cartId: cart.id,
      currency,
      lines,
      subtotalMinor,
      estimatedShippingMinor,
      totalMinor: subtotalMinor + (estimatedShippingMinor ?? 0),
      itemCount,
      hasIssues: lines.some((line) => line.unavailable || line.priceChanged),
    };
  },

  /**
   * Adds a book, or increases an existing line.
   *
   * `quantity` is a delta here and an absolute value in `setQuantity` — adding
   * is naturally cumulative ("add another"), whereas a stepper control sets a
   * number. Conflating the two is how carts end up with 14 copies of one book.
   */
  async addItem(userId: number, bookId: number, quantity: number, countryCode: string | null) {
    const cart = await this.getOrCreate(userId);
    const live = await availabilityService.checkOne(bookId, countryCode ?? '');

    if (typeof live === 'string') {
      const { statusCode, code, message } = unbuyableResponse(live);
      throw httpError(message, statusCode, code);
    }

    const [existing] = await db
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.bookId, bookId)))
      .limit(1);

    if (!existing) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id));

      if (count >= config.commerce.cart.maxItems) {
        throw httpError(
          `A cart can hold at most ${config.commerce.cart.maxItems} different books`,
          409,
          'CART_FULL',
        );
      }
    }

    const target = (existing?.quantity ?? 0) + quantity;
    return this.writeQuantity(cart.id, bookId, target, live);
  },

  /** Sets a line to an absolute quantity. Zero removes it. */
  async setQuantity(userId: number, bookId: number, quantity: number, countryCode: string | null) {
    const cart = await this.getOrCreate(userId);

    if (quantity === 0) {
      await this.removeItem(userId, bookId);
      return null;
    }

    const [existing] = await db
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.bookId, bookId)))
      .limit(1);

    if (!existing) {
      throw httpError('That book is not in your cart', 404, 'NOT_IN_CART');
    }

    const live = await availabilityService.checkOne(bookId, countryCode ?? '');
    if (typeof live === 'string') {
      const { statusCode, code, message } = unbuyableResponse(live);
      throw httpError(message, statusCode, code);
    }

    return this.writeQuantity(cart.id, bookId, quantity, live);
  },

  /**
   * Shared tail of add/set: clamps against both the configured ceiling and live
   * stock, then upserts. Re-capturing the price on every write is what keeps
   * "your price changed" honest — the captured value always reflects the last
   * time the user actively touched the line.
   */
  async writeQuantity(cartId: number, bookId: number, target: number, live: BuyableBook) {
    const ceiling = Math.min(config.commerce.cart.maxQuantityPerLine, live.orderableQuantity);

    if (ceiling <= 0) {
      throw httpError('This book is out of stock', 409, 'OUT_OF_STOCK');
    }

    const quantity = Math.max(1, Math.min(target, ceiling));

    // Line change and cart-timestamp bump in one transaction so cart.updatedAt
    // can't be left stale by a crash between the two writes (the timestamp is
    // what drives "recently modified" ordering elsewhere).
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(cartItems)
        .values({
          cartId,
          bookId,
          isbn13: live.isbn13,
          quantity,
          unitPriceGbpPence: live.unitPriceGbpPence,
          priceCapturedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [cartItems.cartId, cartItems.bookId],
          set: {
            quantity,
            isbn13: live.isbn13,
            unitPriceGbpPence: live.unitPriceGbpPence,
            priceCapturedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
      return inserted;
    });

    return {
      ...row,
      // Surfaced so the client can explain a stepper that refused to go higher.
      clamped: quantity < target,
      clampedTo: quantity,
    };
  },

  async removeItem(userId: number, bookId: number): Promise<void> {
    const cart = await this.getOrCreate(userId);
    await db.transaction(async (tx) => {
      await tx
        .delete(cartItems)
        .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.bookId, bookId)));
      await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cart.id));
    });
  },

  async clear(userId: number): Promise<number> {
    const cart = await this.getOrCreate(userId);
    return db.transaction(async (tx) => {
      const deleted = await tx
        .delete(cartItems)
        .where(eq(cartItems.cartId, cart.id))
        .returning({ id: cartItems.id });
      await tx.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cart.id));
      return deleted.length;
    });
  },
};
