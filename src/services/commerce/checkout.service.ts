/**
 * Turning a cart into a paid order.
 *
 * The ordering of steps below is the whole design, and it is driven by one
 * constraint: **shipping cost and tax both depend on the destination, but
 * Stripe only collects an address after the price is fixed.** Rather than
 * guess and reconcile afterwards, the destination *country* is asked for by our
 * own API up front, everything is priced against it, and Stripe's address
 * collection is then locked to that single country. The address the buyer types
 * can vary in every way except the one we priced on.
 *
 * The alternative — Stripe's dynamic `shipping_options` — would mean expressing
 * every shipping and tax rule in Stripe's model rather than in our own
 * configuration, which is the thing the env-driven design exists to avoid.
 */
import Stripe from 'stripe';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { users, carts, cartItems, orders, orderItems, type Order } from '../../db/schema';
import { config } from '../../config';
import { stripe, assertStripeConfigured } from '../../lib/stripe';
import { withQueryParam } from '../../lib/url';
import { logger } from '../../lib/logger';
import { normalizeEmailForPromotions } from '../../lib/email-identity';
import { stashGuestToken } from '../../lib/guest-token-handoff';
import { checkoutService as subscriptionCheckoutService } from '../subscriptions/checkout.service';
import { paymentsService } from '../payments.service';
import { availabilityService, type UnbuyableReason } from './availability.service';
import type { RequestedLine } from './cart.service';
import {
  generateAccessToken,
  generateOrderReference,
  generateTrackingCode,
  hashToken,
} from '../../lib/order-identity';
import { isDeliverableCountry } from './gardners-countries';
import {
  shippingOptionsService,
  shippingDisplayName,
  type ShippingOption,
} from './shipping-options.service';
import { shippingRatesService } from './shipping-rates.service';
import { measureParcel } from './parcel';
import {
  quoteOrder, resolveCurrency, normalizeCountry, toPresentment, type OrderQuote,
} from './pricing';

/**
 * The address as our own checkout form collects it.
 *
 * When supplied, this — not Stripe — is the shipping address of record, and
 * `countryCode` *is* the destination the order is priced against, so the
 * mismatch between "the country we quoted" and "the country they typed" cannot
 * arise: there is only one country and it came from this object.
 *
 * When omitted, the older flow still applies: the caller names a country,
 * Stripe collects the address, and its collection is locked to that country.
 */
export interface ShippingAddressInput {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode: string;
  countryCode: string;
}

export interface CheckoutChange {
  bookId: number;
  title: string | null;
  kind: 'price_changed' | 'unavailable' | 'quantity_reduced';
  reason?: UnbuyableReason;
  previousUnitPriceMinor?: number;
  unitPriceMinor?: number;
  previousQuantity?: number;
  quantity?: number;
}

export interface CheckoutResult {
  url: string;
  orderId: number;
  sessionId: string;
  /**
   * The client-held key for confirming this payment later, via
   * GET /payments/:reference. Identical in shape to the one the subscription
   * checkout returns, so the app stores one string and never branches on which
   * kind of thing it bought.
   */
  paymentReference: string;
  currency: string;
  totalMinor: number;
  /**
   * What the promotion took off, in the same currency as `totalMinor`. Zero
   * when none applied.
   *
   * This is the first point in the flow where it can be known: eligibility
   * depends on the buyer's email, and the basket endpoints deliberately do not
   * ask for one — see the note in docs/shop-integration.md.
   */
  discountMinor: number;
  /** Why, e.g. `first_order`. Null when there was no discount. */
  discountReason: string | null;
  /** Customer-facing order identity, e.g. `ORD-7K2M9QX4`. Safe to display. */
  reference: string;
  /**
   * Bearer credential for tracking and claiming this order without an account.
   * Returned in the clear here and nowhere else, ever — only its hash is
   * stored. Treat it like a password: never log it, never put it in a URL.
   */
  accessToken: string;
}

function httpError(message: string, statusCode: number, code?: string, extra?: object): Error {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

/**
 * Has this buyer ever paid for anything before?
 *
 * Keyed on the **normalised email**, not the user id, because the shop sells to
 * guests: an account-scoped check is bypassed by simply not signing in. The
 * signed-in user id is checked as well, so someone who changes their email does
 * not thereby earn a second first order.
 *
 * `paid_at IS NOT NULL` rather than a status list: an abandoned checkout leaves
 * a `pending_payment` row behind, and counting those would deny the discount to
 * someone who has never actually bought anything — the worst failure direction,
 * since they are being told they had a first order they never got.
 *
 * This is an anti-abuse *speed bump*, not a wall. A determined person with a
 * second mailbox gets a second discount, and that is an accepted cost — see the
 * note on lib/email-identity.
 */
async function hasPaidBefore(
  normalizedEmail: string,
  userId: number | null,
  handle: DbHandle = db,
): Promise<boolean> {
  const identity = userId === null
    ? eq(orders.contactEmailNormalized, normalizedEmail)
    : or(eq(orders.contactEmailNormalized, normalizedEmail), eq(orders.userId, userId));

  const [existing] = await handle
    .select({ one: sql`1` })
    .from(orders)
    .where(and(identity, isNotNull(orders.paidAt)))
    .limit(1);

  return Boolean(existing);
}

/** Either the pool or a transaction — so money checks can run inside one. */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Postgres unique-violation. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/**
 * Which unique index rejected the write.
 *
 * Two different constraints can fire on the same insert and they want opposite
 * handling: the first-order discount index means "re-price and write again",
 * a tracking code collision means "roll the dice again and write the same
 * order". Without the constraint name the first handler swallows the second.
 */
function violatedConstraint(err: unknown): string | undefined {
  return (err as { constraint?: string })?.constraint;
}

/**
 * The basket being checked out, from whichever of the two places it lives in.
 *
 * A signed-in buyer checks out the cart we store; a guest checks out the basket
 * their client has been holding. From here down the flow is identical, and in
 * both cases every price is read from our own data rather than from anything
 * the caller sent.
 */
async function loadBasket(
  userId: number | null,
  lines: RequestedLine[] | null | undefined,
): Promise<{
  cartId: number | null;
  items: { bookId: number; quantity: number; unitPriceGbpPence: number }[];
}> {
  let cartId: number | null = null;
  let items: { bookId: number; quantity: number; unitPriceGbpPence: number }[];

  if (userId !== null) {
    const [cart] = await db
      .select()
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.status, 'active')))
      .limit(1);

    if (!cart) throw httpError('Your cart is empty', 400, 'CART_EMPTY');

    cartId = cart.id;
    items = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
  } else {
    // Merge duplicates before the caps apply, so two lines of 8 cannot smuggle
    // 16 past a per-line limit of 10.
    const merged = new Map<number, number>();
    for (const line of lines ?? []) {
      const total = (merged.get(line.bookId) ?? 0) + line.quantity;
      merged.set(line.bookId, Math.min(total, config.commerce.cart.maxQuantityPerLine));
    }

    if (merged.size > config.commerce.cart.maxItems) {
      throw httpError(
        `A basket can hold at most ${config.commerce.cart.maxItems} different titles`,
        400,
        'CART_TOO_LARGE',
      );
    }

    items = [...merged.entries()].map(([bookId, quantity]) => ({
      bookId,
      quantity,
      // No captured price exists for a basket we never stored, so there is
      // nothing to have "changed". Seeding this with the live price would be a
      // lie; using the live price as its own baseline simply means a guest is
      // never told a price moved, which is correct — they were never quoted one
      // by us.
      unitPriceGbpPence: -1,
    }));
  }

  if (items.length === 0) {
    throw httpError('Your cart is empty', 400, 'CART_EMPTY');
  }

  return { cartId, items };
}

export const commerceCheckoutService = {
  /**
   * Delivery options for a basket to a country, priced.
   *
   * Reads live prices and stock the same way checkout does, so the options are
   * quoted against the basket that would actually ship rather than whatever the
   * client believes it is holding. Stores nothing.
   */
  async shippingOptions(
    userId: number | null,
    options: { countryCode: string; currency?: string | null; lines?: RequestedLine[] | null },
  ): Promise<{
    currency: string;
    options: ShippingOption[];
    weightEstimated: boolean;
    /** Null when we can ship there; a reason code when we cannot. */
    unavailableReason: 'country_not_supported' | 'no_service' | null;
  }> {
    const destinationCountry = normalizeCountry(options.countryCode);
    if (!destinationCountry) {
      throw httpError('A valid destination country is required', 400, 'INVALID_COUNTRY');
    }

    const currency = resolveCurrency({
      requested: options.currency,
      countryCode: destinationCountry,
    });

    if (!isDeliverableCountry(destinationCountry)) {
      return { currency, options: [], weightEstimated: false, unavailableReason: 'country_not_supported' };
    }

    const { items } = await loadBasket(userId, options.lines);
    const { buyable } = await availabilityService.check(
      items.map((item) => item.bookId),
      destinationCountry,
    );

    // Only what can actually be bought contributes to the parcel. Weighing an
    // out-of-stock line into the total would quote a heavier band than ships.
    const sellable = items.flatMap((item) => {
      const live = buyable.get(item.bookId);
      if (!live) return [];
      const quantity = Math.min(item.quantity, live.orderableQuantity);
      return quantity > 0 ? [{ live, quantity }] : [];
    });

    const subtotalGbpPence = sellable.reduce(
      (sum, { live, quantity }) => sum + live.unitPriceGbpPence * quantity,
      0,
    );

    const { options: available, weightEstimated } = await shippingOptionsService.list({
      countryCode: destinationCountry,
      currency,
      subtotalGbpPence,
      items: sellable.map(({ live, quantity }) => ({
        quantity,
        weightGr: live.weightGr,
        heightMm: live.heightMm,
        widthMm: live.widthMm,
        thicknessMm: live.thicknessMm,
        productForm: live.productForm,
      })),
    });

    return {
      currency,
      options: available,
      weightEstimated,
      unavailableReason: available.length === 0 ? 'no_service' : null,
    };
  },

  /**
   * Validates, prices, persists and hands back a Stripe Checkout URL.
   *
   * Throws a 409 carrying `changes` if anything moved since the cart was last
   * looked at. The cart is repaired in place before that throw, so the client's
   * retry — after the user has seen what changed — succeeds without them having
   * to rebuild the basket.
   */
  async start(
    /** Null for a guest, whose basket arrives in `lines` instead. */
    userId: number | null,
    options: {
      destinationCountry: string;
      currency?: string | null;
      address?: ShippingAddressInput | null;
      /**
       * Required for a guest — there is no account to read an email from, and
       * an order with no way to reach the buyer is not an order. Ignored for a
       * signed-in buyer, whose account email is authoritative: letting a
       * request name its own contact address would turn checkout into a way to
       * send someone else's receipt wherever you liked.
       */
      contactEmail?: string | null;
      /**
       * E.164 delivery contact. Optional: the older flow, where Stripe collects
       * the address, never asks for one, and an order without a phone number
       * still ships.
       *
       * Honoured for signed-in buyers as well as guests — see the note on the
       * field in cart.controller. When a signed-in buyer omits it, their stored
       * profile number is used, so the common case needs no field at all.
       */
      contactPhone?: string | null;
      /**
       * The guest's basket, straight from the request body. Required when
       * `userId` is null and ignored otherwise — a signed-in buyer checks out
       * the cart we hold, so accepting lines for them would let a request buy
       * something that was never in their basket.
       *
       * Only book ids and quantities are read. Every price is computed here.
       */
      lines?: RequestedLine[] | null;
      /**
       * The delivery service the buyer chose, from `shippingOptions` below.
       * Validated against the destination before anything is charged; absent
       * means the cheapest available service, so a client that never showed a
       * chooser does not silently upgrade the buyer onto the dear one.
       */
      shippingServiceCode?: string | null;
    },
  ): Promise<CheckoutResult> {
    assertStripeConfigured();

    // The address, when present, is the single source of the destination.
    const destinationCountry = normalizeCountry(
      options.address?.countryCode ?? options.destinationCountry,
    );
    if (!destinationCountry) {
      throw httpError('A valid destination country is required', 400, 'INVALID_COUNTRY');
    }

    // Refuse a destination we cannot address a Gardners parcel to — here,
    // before a Stripe session exists, rather than at fulfilment. Discovering it
    // after the card is charged means refunding an order we were never able to
    // ship, and refunds are currently a manual Stripe action plus a phone call.
    // The fix for a genuine gap is an env entry, not a deploy: see
    // GARDNERS_COUNTRY_NAMES_EXTRA.
    if (!isDeliverableCountry(destinationCountry)) {
      logger.warn('Refused checkout to a country with no Gardners name mapping', {
        userId,
        destinationCountry,
      });
      throw httpError(
        'We cannot ship to that country yet',
        409,
        'COUNTRY_NOT_SUPPORTED',
      );
    }

    const { cartId, items } = await loadBasket(userId, options.lines);

    const currency = resolveCurrency({
      requested: options.currency,
      countryCode: destinationCountry,
    });

    // The binding availability check: real destination, live price, live stock.
    const { buyable, rejected } = await availabilityService.check(
      items.map((item) => item.bookId),
      destinationCountry,
    );

    const changes: CheckoutChange[] = [];

    for (const item of items) {
      const live = buyable.get(item.bookId);

      if (!live) {
        changes.push({
          bookId: item.bookId,
          title: null,
          kind: 'unavailable',
          reason: rejected.get(item.bookId),
        });
        continue;
      }

      if (item.unitPriceGbpPence >= 0 && live.unitPriceGbpPence !== item.unitPriceGbpPence) {
        changes.push({
          bookId: item.bookId,
          title: live.title,
          kind: 'price_changed',
          previousUnitPriceMinor: toPresentment(item.unitPriceGbpPence, currency),
          unitPriceMinor: toPresentment(live.unitPriceGbpPence, currency),
        });
      }

      // orderableQuantity, not stockQty: a supply-to-order title reports zero
      // stock and is still buyable, so clamping on the shelf figure would
      // reduce every one of those lines to nothing.
      if (live.orderableQuantity < item.quantity) {
        changes.push({
          bookId: item.bookId,
          title: live.title,
          kind: 'quantity_reduced',
          previousQuantity: item.quantity,
          quantity: live.orderableQuantity,
        });
      }
    }

    if (changes.length > 0) {
      // Only a stored cart can be repaired. A guest's basket lives on their
      // client, so the changes are reported and the client reconciles.
      if (cartId !== null) await this.repairCart(cartId, items, buyable);
      throw httpError('Some items in your cart changed', 409, 'CART_CHANGED', {
        details: { changes },
      });
    }

    // The account's own email for a signed-in buyer; the one they typed for a
    // guest. Never the request body's value for a signed-in buyer — see the
    // note on `contactEmail` above.
    let contactEmail: string;
    // Falls back to the account's stored number when the request omits one, so
    // a returning buyer is not made to retype it. Null for a guest who gave
    // none: there is no profile to fall back to.
    let contactPhone: string | null = options.contactPhone ?? null;
    if (userId !== null) {
      const [user] = await db
        .select({ email: users.email, phone: users.phone, blacklistedAt: users.blacklistedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw httpError('User not found', 404);
      // A blacklisted customer cannot buy. Checked here rather than only at
      // login because a session issued before the blacklist stays valid until
      // its token expires, and "blocked" that still lets you spend money is not
      // blocked.
      if (user.blacklistedAt !== null) {
        throw httpError('This account has been suspended. Contact support.', 403, 'ACCOUNT_SUSPENDED');
      }
      contactEmail = user.email;
      contactPhone ??= user.phone;
    } else {
      if (!options.contactEmail) {
        throw httpError('An email address is required to check out', 400, 'EMAIL_REQUIRED');
      }
      contactEmail = options.contactEmail;
    }

    const normalizedEmail = normalizeEmailForPromotions(contactEmail);
    const firstOrderPercent = config.commerce.discount.firstOrderPercent;

    // ── Delivery service ──────────────────────────────────────────────────────
    // Resolved before pricing, because it is an input to the price. Under the
    // flat table this is all inert: shippingServiceCode stays null and
    // quoteOrder ignores the parcel it is handed.
    let shippingServiceCode: string | null = null;
    let rateCard: Awaited<ReturnType<typeof shippingRatesService.load>> | undefined;
    let parcel: ReturnType<typeof measureParcel> | undefined;

    if (config.commerce.shipping.useRateTable) {
      // The parcel is weighed first: which service can be used depends on
      // whether it can carry this weight, so the default choice below needs the
      // weight in hand before it picks.
      rateCard = await shippingRatesService.load();
      parcel = measureParcel(
        items.flatMap((item) => {
          const live = buyable.get(item.bookId);
          return live
            ? [{
                quantity: item.quantity,
                weightGr: live.weightGr,
                heightMm: live.heightMm,
                widthMm: live.widthMm,
                thicknessMm: live.thicknessMm,
                productForm: live.productForm,
              }]
            : [];
        }),
      );

      // Pre-discount subtotal, matching how quoteOrder quotes shipping — the
      // free-shipping threshold looks at the goods total, so the fit check has
      // to price each service the same way the real quote will.
      const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
      const subtotalGbpPence = items.reduce((sum, item) => {
        const live = buyable.get(item.bookId);
        return live ? sum + live.unitPriceGbpPence * item.quantity : sum;
      }, 0);

      const requested = options.shippingServiceCode?.trim();

      if (requested) {
        // A code the client made up, or one that does not serve this country,
        // is a 400 rather than a silent downgrade: the buyer is looking at a
        // price for a service, and quietly charging them for a different one is
        // the worst available outcome.
        if (!(await shippingOptionsService.isAvailable(destinationCountry, requested))) {
          throw httpError(
            'That delivery option is not available for this destination',
            400,
            'SHIPPING_SERVICE_UNAVAILABLE',
          );
        }
        shippingServiceCode = requested;
      } else {
        // No chooser was shown, so pick the cheapest service that can actually
        // carry this parcel — the same filter the options list applies. Passing
        // the parcel is the whole fix: choosing on country coverage alone could
        // land on untracked airmail (2kg ceiling) for a heavier basket and then
        // fail pricing with a 500.
        shippingServiceCode = await shippingOptionsService.defaultServiceCode(destinationCountry, {
          itemCount,
          subtotalGbpPence,
          parcel,
          rateCard,
        });
      }

      if (!shippingServiceCode) {
        // Two ways to land here: the country has no published rate at all, or it
        // has one but nothing in the table can carry a parcel this heavy. They
        // want different messages — telling someone with a heavy basket that we
        // "don't ship there" sends them away from an order they could complete
        // by dropping an item.
        const countryHasAnyService =
          (await shippingOptionsService.defaultServiceCode(destinationCountry)) !== null;

        if (countryHasAnyService) {
          logger.warn('Refused checkout: basket too heavy for every service to destination', {
            userId,
            destinationCountry,
            parcelWeightG: parcel.weightG,
          });
          throw httpError(
            'This basket is too heavy to ship to your country. Remove an item and try again.',
            409,
            'PARCEL_TOO_HEAVY',
          );
        }

        // Deliverable by name, but nothing in the rate table can carry it —
        // the five countries Gardners publish no price for. Refused here, before
        // a Stripe session exists.
        logger.warn('Refused checkout to a country with no shipping rate', {
          userId,
          destinationCountry,
        });
        throw httpError(
          'We cannot ship to that country yet',
          409,
          'COUNTRY_NOT_SUPPORTED',
        );
      }
    }

    /**
     * Prices the basket, with or without the promotion.
     *
     * A function rather than a value because the discount decision is made
     * *inside* the transaction that writes the order, and may have to be
     * retracted and the basket re-priced if the database refuses it.
     */
    const priceBasket = (discountPercent: number) =>
      quoteOrder({
        lines: items.map((item) => {
          const live = buyable.get(item.bookId)!;
          return {
            bookId: item.bookId,
            isbn13: live.isbn13,
            quantity: item.quantity,
            unitPriceGbpPence: live.unitPriceGbpPence,
          };
        }),
        destinationCountry,
        currency,
        discountPercent,
        discountReason: 'first_order',
        serviceCode: shippingServiceCode ?? undefined,
        parcel,
        rateCard,
      });

    // Handed back to the caller in the clear exactly once; only its hash is
    // stored. This is what lets the confirmation screen offer "Track My Order"
    // and "Save your order details" to somebody with no account yet.
    const accessToken = generateAccessToken();

    /**
     * Writes the order, deciding the discount inside the same transaction that
     * records it.
     *
     * Two layers, because one is not enough:
     *
     * 1. **The eligibility read moves inside the transaction**, so it sees a
     *    consistent snapshot with the write rather than whatever was true a few
     *    hundred milliseconds earlier.
     * 2. **A partial unique index does the actual enforcing.** Two checkouts
     *    starting at the same instant both legitimately see "no paid order" —
     *    no isolation level makes that untrue, because at that moment it *is*
     *    true. Only a constraint evaluated at write time can stop them both
     *    being written, and `uq_orders_first_order_discount` is it.
     *
     * When the index refuses the second one, the order is re-priced without the
     * promotion and written again. The buyer gets an order rather than an
     * error — they were never entitled to two discounts, and failing their
     * checkout to tell them so would be the wrong end of the trade.
     */
    const writeOrder = async (quote: OrderQuote) =>
      db.transaction(async (tx) => {
        const [created] = await tx
          .insert(orders)
          .values({
            userId,
            cartId,
            reference: generateOrderReference(),
            trackingCode: generateTrackingCode(),
            guestAccessTokenHash: hashToken(accessToken),
            status: 'pending_payment',
            subtotalGbpPence: quote.subtotalGbpPence,
            discountGbpPence: quote.discountGbpPence,
            discountMinor: quote.discountMinor,
            discountReason: quote.discountReason,
            shippingGbpPence: quote.shippingGbpPence,
            taxGbpPence: quote.taxGbpPence,
            totalGbpPence: quote.totalGbpPence,
            presentmentCurrency: quote.currency,
            subtotalMinor: quote.subtotalMinor,
            shippingMinor: quote.shippingMinor,
            taxMinor: quote.taxMinor,
            totalMinor: quote.totalMinor,
            fxRate: String(quote.fxRate),
            fxCapturedAt: quote.fxCapturedAt,
            taxRatePercent: String(quote.taxRatePercent),
            taxSource: quote.taxSource,
            shippingRule: quote.shippingRule,
            shippingServiceCode: quote.shippingServiceCode,
            shippingWeightG: quote.shippingWeightG,
            shippingWeightEstimated: quote.shippingWeightEstimated,
            shippingCountryCode: destinationCountry,
            contactEmail,
            contactEmailNormalized: normalizedEmail,
            contactPhone,
            // Written before payment when we collected it ourselves. The paid
            // webhook will not overwrite these with Stripe's (absent) values —
            // see definedShipping in orders.service.
            ...(options.address && {
              shippingName: options.address.name,
              shippingLine1: options.address.line1,
              shippingLine2: options.address.line2 ?? null,
              shippingCity: options.address.city,
              shippingRegion: options.address.region ?? null,
              shippingPostcode: options.address.postcode,
            }),
          })
          .returning();

        await tx.insert(orderItems).values(
          quote.lines.map((line) => {
            const live = buyable.get(line.bookId)!;
            return {
              orderId: created.id,
              bookId: line.bookId,
              isbn13: line.isbn13,
              quantity: line.quantity,
              unitPriceGbpPence: line.unitPriceGbpPence,
              lineTotalGbpPence: line.lineTotalGbpPence,
              unitPriceMinor: line.unitPriceMinor,
              lineTotalMinor: line.lineTotalMinor,
              titleSnapshot: live.title.slice(0, 500),
              contributorSnapshot: live.contributor?.slice(0, 500) ?? null,
            };
          }),
        );

        return created;
      });

    // The eligibility read happens inside a transaction with the write it
    // informs, and the unique index is what settles a genuine tie.
    let quote = await db.transaction(async (tx) => {
      const eligible =
        config.commerce.discount.firstOrderPercent > 0 &&
        !(await hasPaidBefore(normalizedEmail, userId, tx));
      return priceBasket(eligible ? firstOrderPercent : 0);
    });

    /**
     * Writes the order, absorbing the two unique violations that are expected
     * here rather than exceptional.
     *
     * A tracking code collision is retried in place — the order is fine, only
     * its code was unlucky, and writeOrder generates a fresh one on every call
     * so going round again is the whole fix. At ~1.1e12 codes this is a lottery
     * win rather than a hot path, but the alternative is failing a checkout on
     * a coin flip.
     */
    let written: Order | undefined;

    for (let attempt = 0; !written; attempt++) {
      try {
        written = await writeOrder(quote);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;

        if (violatedConstraint(err) === 'orders_tracking_code_unique') {
          if (attempt >= 4) throw err;
          logger.warn('Tracking code collision — regenerating', { attempt });
          continue;
        }

        if (quote.discountGbpPence === 0) throw err;

        // Another checkout for this mailbox already holds the first-order
        // discount. Re-price without it and write again, rather than failing a
        // checkout over a promotion the buyer was never owed twice.
        logger.info('First-order discount already claimed for this buyer — pricing without it', {
          normalizedEmail,
        });
        quote = priceBasket(0);
      }
    }

    // Re-bound as a const before anything closes over it. The loop above cannot
    // exit with it unset, but narrowing a `let` across a closure boundary only
    // survives on TypeScript 5.4+ — and the transaction callback below captures
    // it. A const is narrowed the same way on every version.
    const order: Order = written;

    const session = await this.createSession(userId, order, quote.lines.map((line) => ({
      name: buyable.get(line.bookId)!.title,
      contributor: buyable.get(line.bookId)!.contributor,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
    })));

    // Order-side link back to the Stripe session and the payment row that
    // fronts it. Both writes are committed together: if only one landed, a
    // webhook arriving before the follow-up either couldn't find the order
    // for its session id (session id column not set) or couldn't find the
    // payment behind the reference we handed the client (payment row not
    // inserted) — the client would see 'payment not found' for a checkout
    // that in fact went through.
    const payment = await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({ stripeCheckoutSessionId: session.id, updatedAt: new Date() })
        .where(eq(orders.id, order.id));

      return paymentsService.create(
        {
          userId,
          kind: 'order',
          stripeCheckoutSessionId: session.id,
          amountCents: quote.totalMinor,
          currency: quote.currency,
          orderId: order.id,
        },
        tx,
      );
    });

    logger.info('Checkout session created', {
      orderId: order.id,
      userId,
      currency: quote.currency,
      totalMinor: quote.totalMinor,
      destinationCountry,
      paymentReference: payment.reference,
    });

    // Parked for the confirmation email, which is sent from the paid webhook
    // long after this raw value is gone. Guests only — a signed-in buyer has
    // order history and needs no credential printed in an inbox.
    if (userId === null) {
      await stashGuestToken(order.id, accessToken);
    }

    return {
      url: session.url!,
      orderId: order.id,
      sessionId: session.id,
      paymentReference: payment.reference,
      currency: quote.currency,
      totalMinor: quote.totalMinor,
      discountMinor: quote.discountMinor,
      discountReason: quote.discountReason,
      reference: order.reference,
      accessToken,
    };
  },

  /**
   * Builds the Stripe session.
   *
   * Line items are built from what the server just computed — never from the
   * request body. This is the same rule `resolvePrice()` enforces on the
   * subscription side, and it is what stops a crafted request buying a book at
   * a price of its own choosing.
   */
  async createSession(
    userId: number | null,
    order: Order,
    lines: { name: string; contributor: string | null; quantity: number; unitPriceMinor: number }[],
  ): Promise<Stripe.Checkout.Session> {
    // A guest has no Stripe customer and must not be given one: creating
    // customer records for people without accounts builds a second, unlinked
    // identity store that nothing in the app can ever reconcile or delete on
    // request. Stripe takes the email directly instead.
    const customerId =
      userId !== null ? await subscriptionCheckoutService.ensureStripeCustomer(userId) : null;
    const currency = order.presentmentCurrency.toLowerCase();

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = lines.map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency,
        unit_amount: line.unitPriceMinor,
        product_data: {
          name: line.name.slice(0, 250),
          ...(line.contributor && { description: line.contributor.slice(0, 250) }),
        },
      },
    }));

    // Tax as its own line rather than a Stripe TaxRate object: the rate comes
    // from our own env table (see VAT_RATES), and mirroring it into Stripe's
    // tax objects would create a second place for it to be wrong. When Stripe
    // Tax replaces the env table, this becomes `automatic_tax: { enabled: true }`
    // and this block goes away.
    if (order.taxMinor > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency,
          unit_amount: order.taxMinor,
          product_data: { name: `VAT (${Number(order.taxRatePercent)}%)` },
        },
      });
    }

    // A one-off, single-redemption coupon for the exact amount our own quote
    // took off, rather than a reusable `percent_off` one.
    //
    // Percent-off would have Stripe recompute the reduction from its own line
    // items and round it its own way, which can disagree with the stored
    // `total_minor` by a penny or two — and this codebase's whole money design
    // rests on the amount charged provably equalling the amount stored. An
    // `amount_off` coupon reduces the session total by exactly the integer we
    // already committed to the order row.
    //
    // Shipping is a `shipping_option`, not a line item, so it is untouched by
    // the coupon — which matches the quote, where the discount never applies to
    // delivery.
    const discounts: Stripe.Checkout.SessionCreateParams.Discount[] = [];
    if (order.discountMinor > 0) {
      const coupon = await stripe().coupons.create({
        amount_off: order.discountMinor,
        currency,
        duration: 'once',
        max_redemptions: 1,
        name: order.discountReason === 'first_order' ? 'First order discount' : 'Discount',
        metadata: { orderId: String(order.id), reason: order.discountReason ?? '' },
      });
      discounts.push({ coupon: coupon.id });
    }

    // Already have an address? Then Stripe is a payment processor on this
    // order and nothing else. Asking it to collect an address we already hold
    // would mean two addresses to reconcile and a second chance for the
    // destination to drift away from the one shipping and tax were priced on.
    const weHoldTheAddress = Boolean(order.shippingLine1);

    return stripe().checkout.sessions.create({
      mode: 'payment',
      ...(customerId
        ? {
            customer: customerId,
            // Lets Stripe write the collected shipping address back onto the
            // customer, so a returning buyer is not retyping it every time.
            // Only valid alongside address collection.
            ...(weHoldTheAddress ? {} : { customer_update: { shipping: 'auto' as const } }),
          }
        : { customer_email: order.contactEmail }),
      line_items: lineItems,
      ...(discounts.length > 0 && { discounts }),
      // Locked to the country the order was priced against. The buyer can
      // correct any part of their address except the one that would invalidate
      // the shipping and tax we already quoted.
      ...(weHoldTheAddress
        ? {}
        : {
            shipping_address_collection: {
              allowed_countries: [
                order.shippingCountryCode as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry,
              ],
            },
          }),
      ...(order.shippingMinor > 0 && {
        shipping_options: [
          {
            shipping_rate_data: {
              type: 'fixed_amount' as const,
              fixed_amount: { amount: order.shippingMinor, currency },
              // Name the service the buyer chose rather than a generic
              // "Delivery" — someone who paid £32.52 for tracked postage should
              // see that on the Stripe page, not a bare total they have to take
              // on trust.
              display_name: shippingDisplayName(order.shippingServiceCode),
            },
          },
        ],
      }),
      client_reference_id: String(order.id),
      // `kind` is what lets the shared webhook tell an order apart from a
      // subscription without inspecting line items.
      // No userId for a guest. The order id is the durable link the webhook
      // actually uses; userId is only here for operator triage in the Stripe
      // dashboard, so its absence costs nothing.
      metadata: {
        kind: 'order',
        orderId: String(order.id),
        ...(userId !== null && { userId: String(userId) }),
      },
      success_url: withQueryParam(config.commerce.orderSuccessUrl, 'orderId', String(order.id)),
      cancel_url: withQueryParam(config.commerce.orderCancelUrl, 'orderId', String(order.id)),
    });
  },

  /**
   * Brings a cart back in line with reality after a failed checkout: drops what
   * cannot be bought, re-captures prices, and trims quantities to available
   * stock.
   *
   * Done *before* the 409 is thrown so that the user, having read what changed,
   * can simply press the button again.
   */
  async repairCart(
    cartId: number,
    items: { bookId: number; quantity: number }[],
    buyable: Map<number, { isbn13: string; unitPriceGbpPence: number; orderableQuantity: number }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      for (const item of items) {
        const live = buyable.get(item.bookId);

        if (!live) {
          await tx
            .delete(cartItems)
            .where(and(eq(cartItems.cartId, cartId), eq(cartItems.bookId, item.bookId)));
          continue;
        }

        await tx
          .update(cartItems)
          .set({
            unitPriceGbpPence: live.unitPriceGbpPence,
            priceCapturedAt: new Date(),
            quantity: Math.max(1, Math.min(item.quantity, live.orderableQuantity)),
            updatedAt: new Date(),
          })
          .where(and(eq(cartItems.cartId, cartId), eq(cartItems.bookId, item.bookId)));
      }
    });
  },
};
