import { eq, and } from 'drizzle-orm';
import type Stripe from 'stripe';
import { db } from '../db';
import { payments } from '../db/schema/payments';
import type { Payment, PaymentKind, PaymentStatus } from '../db/schema/payments';
import { stripe, isStripeConfigured } from '../lib/stripe';
import { randomCode } from '../lib/random-code';
import { logger } from '../lib/logger';

/** Either the root db handle or an open transaction. */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * "Did the payment I just made go through?"
 *
 * One reference, minted when a Checkout Session is created and returned to the
 * client alongside the Stripe URL, exchangeable later for a status. The client
 * holds one opaque string and never has to know whether it bought a subscription
 * or a basket of books.
 *
 * This service is a *confirmation* surface, not a billing record. Stripe is the
 * source of truth; `user_subscriptions` and `orders` remain what the rest of the
 * system acts on. Nothing here grants entitlement — it reports.
 */

// 12 characters of Crockford base32 after the prefix. Long enough that guessing
// is hopeless, short enough to read down a phone line to support.
const REFERENCE_LENGTH = 12;
const REFERENCE_PREFIX = 'KP-';

/**
 * How stale a pending payment may be before the confirm endpoint will ask Stripe
 * again.
 *
 * A client polling every second while staring at a spinner must not turn one
 * checkout into hundreds of Stripe API calls. Two seconds is short enough to
 * feel instant and long enough to collapse a tight polling loop.
 */
const RECHECK_INTERVAL_MS = 2_000;

export function generateReference(): string {
  return REFERENCE_PREFIX + randomCode(REFERENCE_LENGTH);
}

export interface PaymentConfirmation {
  reference: string;
  kind: PaymentKind;
  status: PaymentStatus;
  /** True only for `succeeded` — the single field a client needs to branch on. */
  paid: boolean;
  amountCents: number | null;
  currency: string | null;
  orderId: number | null;
  paidAt: string | null;
  /** Present on failed/expired/cancelled. Safe to show; never raw Stripe internals. */
  reason: string | null;
}

/**
 * Maps a Stripe Checkout Session onto our status vocabulary.
 *
 * Kept pure and exported so the mapping can be tested against every state a
 * session can be in without a Stripe account — this is the part that decides
 * whether a user is told their payment worked, so being wrong here is expensive
 * in both directions.
 *
 * Stripe splits this across two fields, and both matter: `status` describes the
 * session (open / complete / expired) while `payment_status` describes the money
 * (paid / unpaid / no_payment_required). A session can be `complete` with
 * `payment_status: 'unpaid'` — a delayed-settlement method that has not cleared —
 * and reporting that as success would hand over goods for money that never
 * arrived.
 */
export function statusFromSession(session: {
  status?: string | null;
  payment_status?: string | null;
}): PaymentStatus {
  if (session.status === 'expired') return 'expired';

  if (session.status === 'complete') {
    // `no_payment_required` covers 100%-discounted or trial-only sessions:
    // legitimately complete with nothing charged.
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      return 'succeeded';
    }
    // Complete but unpaid — a delayed notification method still settling.
    return 'pending';
  }

  // 'open' — the user is still on the Stripe page, or abandoned it without the
  // session having expired yet. Not a failure, just not finished.
  return 'pending';
}

export const paymentsService = {
  generateReference,
  statusFromSession,

  /**
   * Records a Checkout Session and returns the reference to hand back with the
   * Stripe URL.
   *
   * Called by both checkout flows. Idempotent on the session id: creating the
   * same session twice returns the existing reference rather than minting a
   * second one for the same money.
   *
   * Accepts an optional transaction so the caller can commit this alongside
   * another write — the order-checkout flow uses that to keep the order's
   * stripe_checkout_session_id column and the payment row atomic, since one
   * without the other means the webhook can't correlate the order back to
   * the payment (or vice versa).
   */
  async create(
    params: {
      /** Null for a guest order's payment — nobody was signed in to attribute
       * it to. Confirmation for those goes through the order's access token
       * (see orders lookup), not through GET /payments/:reference, which stays
       * scoped to the authenticated user. */
      userId: number | null;
      kind: PaymentKind;
      stripeCheckoutSessionId: string;
      amountCents?: number | null;
      currency?: string | null;
      orderId?: number | null;
    },
    tx?: DbHandle,
  ): Promise<Payment> {
    const handle = tx ?? db;
    const [existing] = await handle
      .select()
      .from(payments)
      .where(eq(payments.stripeCheckoutSessionId, params.stripeCheckoutSessionId))
      .limit(1);
    if (existing) return existing;

    const [row] = await handle
      .insert(payments)
      .values({
        reference: generateReference(),
        userId: params.userId,
        kind: params.kind,
        stripeCheckoutSessionId: params.stripeCheckoutSessionId,
        amountCents: params.amountCents ?? null,
        currency: params.currency ?? null,
        orderId: params.orderId ?? null,
      })
      .returning();

    return row;
  },

  /**
   * The confirm read: our record first, Stripe as fallback.
   *
   * The fallback is the whole point. A user comes back from the Stripe page in
   * well under a second, often before the webhook has been delivered — so a
   * database-only answer would say "pending" precisely when the user is looking
   * at the screen asking whether it worked. When our row is still pending we ask
   * Stripe directly and write the answer back, so the app gets a definitive
   * result on the first call instead of polling into an indefinite pending
   * state.
   *
   * Ownership is part of the query, not a check after it: a reference belonging
   * to another user is indistinguishable from one that does not exist, so this
   * cannot be used to probe other people's payments.
   */
  async confirm(reference: string, userId: number): Promise<PaymentConfirmation | null> {
    const [row] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.reference, reference.toUpperCase()), eq(payments.userId, userId)))
      .limit(1);

    if (!row) return null;

    const settled = row.status !== 'pending';
    const checkedRecently =
      row.lastCheckedAt !== null && Date.now() - row.lastCheckedAt.getTime() < RECHECK_INTERVAL_MS;

    if (settled || checkedRecently || !isStripeConfigured()) {
      return toConfirmation(row);
    }

    return toConfirmation(await this.reconcile(row));
  },

  /**
   * Asks Stripe what actually happened and writes it back.
   *
   * Never throws: a Stripe outage must degrade to "still pending" rather than
   * failing the request. The user is looking at a confirmation screen, and an
   * error there reads as "my payment broke" when the truth is "we could not
   * check just now".
   */
  async reconcile(row: Payment): Promise<Payment> {
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe().checkout.sessions.retrieve(row.stripeCheckoutSessionId);
    } catch (err) {
      logger.warn('Could not reach Stripe to confirm a payment', {
        reference: row.reference,
        error: (err as Error).message,
      });
      // Stamp the attempt so a client polling through an outage still backs off.
      const [touched] = await db
        .update(payments)
        .set({ lastCheckedAt: new Date(), updatedAt: new Date() })
        .where(eq(payments.id, row.id))
        .returning();
      return touched ?? row;
    }

    const status = statusFromSession(session);
    const now = new Date();

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

    const [updated] = await db
      .update(payments)
      .set({
        status,
        stripePaymentIntentId: paymentIntentId ?? row.stripePaymentIntentId,
        amountCents: session.amount_total ?? row.amountCents,
        currency: session.currency?.toUpperCase() ?? row.currency,
        lastCheckedAt: now,
        updatedAt: now,
        // Only stamp the first time it settles, so a later re-read doesn't keep
        // moving the moment the payment completed.
        resolvedAt: status !== 'pending' ? row.resolvedAt ?? now : row.resolvedAt,
      })
      .where(eq(payments.id, row.id))
      .returning();

    if (status !== row.status) {
      logger.info('Payment status resolved from Stripe', {
        reference: row.reference,
        from: row.status,
        to: status,
      });
    }

    return updated ?? row;
  },

  /** Marks a payment from a webhook, by Checkout Session id. Best-effort. */
  async markFromSession(
    stripeCheckoutSessionId: string,
    status: PaymentStatus,
    failureReason?: string,
  ): Promise<void> {
    const now = new Date();
    await db
      .update(payments)
      .set({
        status,
        failureReason: failureReason ?? null,
        updatedAt: now,
        resolvedAt: status !== 'pending' ? now : null,
      })
      .where(eq(payments.stripeCheckoutSessionId, stripeCheckoutSessionId));
  },
};

function toConfirmation(row: Payment): PaymentConfirmation {
  return {
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    paid: row.status === 'succeeded',
    amountCents: row.amountCents,
    currency: row.currency,
    orderId: row.orderId,
    paidAt: row.status === 'succeeded' ? row.resolvedAt?.toISOString() ?? null : null,
    reason: row.failureReason,
  };
}
