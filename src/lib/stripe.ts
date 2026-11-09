import Stripe from 'stripe';
import { config } from '../config';
import type { SubscriptionPlan } from '../db/schema';

/**
 * Stripe client and price resolution.
 *
 * Stripe config is optional at boot (see src/config/index.ts) so the server
 * still starts in local development, CI and any environment that predates
 * payments. Everything here therefore fails at the point of use with a clear
 * message rather than at import time.
 */

let client: Stripe | null = null;

/** True when this environment has enough Stripe config to take a payment. */
export function isStripeConfigured(): boolean {
  return Boolean(
    config.stripe.secretKey &&
      config.stripe.prices.monthly &&
      config.stripe.prices.annual,
  );
}

/**
 * Throws a 503 if Stripe isn't configured. Called by every route that needs
 * to talk to Stripe — a missing key is an operator mistake, not a client one,
 * so it must not read as a 400.
 */
export function assertStripeConfigured(): void {
  if (!isStripeConfigured()) {
    throw Object.assign(new Error('Payments are not available right now'), {
      statusCode: 503,
      code: 'PAYMENTS_UNAVAILABLE',
    });
  }
}

export function stripe(): Stripe {
  if (!config.stripe.secretKey) {
    throw Object.assign(new Error('Payments are not available right now'), {
      statusCode: 503,
      code: 'PAYMENTS_UNAVAILABLE',
    });
  }
  if (!client) {
    // Pinned so a Stripe-side API upgrade can never change the shape of the
    // webhook payloads this server parses. Matches the version the installed
    // SDK's types are generated against.
    client = new Stripe(config.stripe.secretKey, { apiVersion: '2026-07-29.dahlia' });
  }
  return client;
}

// ── Founding Member pricing ────────────────────────────────────────────────────

/** Adds calendar months in UTC, clamped to month end (31 Jan + 1 = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * When an account's founding window closes: sign-up plus FOUNDING_PERIOD_MONTHS.
 * Null when the offer is switched off.
 */
export function foundingWindowEndsAt(signedUpAt: Date): Date | null {
  const months = config.stripe.foundingPeriodMonths;
  return months > 0 ? addMonths(signedUpAt, months) : null;
}

/**
 * Whether a founding window is still open. Founding pricing is expressed as its
 * own Stripe Prices rather than a coupon, so that what a subscriber is paying
 * is always readable from the subscription itself.
 */
export function isFoundingWindowOpen(endsAt: Date | null | undefined, now: Date = new Date()): boolean {
  return Boolean(endsAt && now < endsAt);
}

/**
 * The founding window a Stripe subscription was sold under. Checkout stamps its
 * end into the subscription's metadata; a subscription without one was bought
 * under the old launch-wide window (`legacy`) and keeps that window's end date
 * and that rule's timing.
 */
export function foundingTermOf(subscription: Pick<Stripe.Subscription, 'metadata'>): {
  endsAt: Date | null;
  legacy: boolean;
} {
  const stamped = subscription.metadata?.foundingEndsAt;
  if (stamped) {
    const date = new Date(stamped);
    if (!Number.isNaN(date.getTime())) return { endsAt: date, legacy: false };
  }
  return { endsAt: config.stripe.legacyFoundingEndsAt ?? null, legacy: true };
}

export interface ResolvedPrice {
  /** The price the subscription actually starts on. */
  priceId: string;
  /** The price it rolls onto after the first term, if this is a founding deal. */
  standardPriceId: string;
  isFounding: boolean;
}

/**
 * Picks the Price for a plan, server-side. The client only ever names a plan
 * ('monthly' | 'annual') — it can never hand us a price id, which is what stops
 * a crafted request from buying Plus at a price of its own choosing.
 *
 * `foundingEndsAt` is the buyer's founding window (see foundingWindowEndsAt):
 * inside it they get the founding price, and the rollover to standard is
 * attached as a Stripe subscription schedule once a renewal would land after
 * it (see scheduleFoundingRollover), which is why the standard price id comes
 * back alongside it.
 */
export function resolvePrice(
  plan: SubscriptionPlan,
  foundingEndsAt: Date | null,
  now: Date = new Date(),
): ResolvedPrice {
  const { prices } = config.stripe;
  const standardPriceId = plan === 'monthly' ? prices.monthly : prices.annual;

  if (!standardPriceId) {
    throw Object.assign(new Error('Payments are not available right now'), {
      statusCode: 503,
      code: 'PAYMENTS_UNAVAILABLE',
    });
  }

  const foundingPriceId = plan === 'monthly' ? prices.monthlyFounding : prices.annualFounding;

  // A founding window with no founding price configured is a misconfiguration,
  // not a reason to charge someone the wrong amount — fall back to standard.
  if (isFoundingWindowOpen(foundingEndsAt, now) && foundingPriceId) {
    return { priceId: foundingPriceId, standardPriceId, isFounding: true };
  }

  return { priceId: standardPriceId, standardPriceId, isFounding: false };
}

/** Maps a Stripe price id back to the plan it represents, for webhook writes. */
export function planForPriceId(priceId: string | null | undefined): SubscriptionPlan | null {
  if (!priceId) return null;
  const { prices } = config.stripe;
  if (priceId === prices.monthly || priceId === prices.monthlyFounding) return 'monthly';
  if (priceId === prices.annual || priceId === prices.annualFounding) return 'annual';
  return null;
}

/** Whether a price id is one of the Founding Member prices. */
export function isFoundingPriceId(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  const { prices } = config.stripe;
  return priceId === prices.monthlyFounding || priceId === prices.annualFounding;
}
