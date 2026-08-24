import { redis } from './redis';

/**
 * Carries a guest's raw tracking token from checkout to the paid webhook.
 *
 * The problem this solves: the token is generated at checkout and only its
 * **hash** is stored, deliberately — it is a bearer credential. The
 * confirmation email is sent from the Stripe webhook minutes later, by which
 * point the raw value is gone, and a guest who closed the tab has no way back
 * to their order. Ever.
 *
 * So it is parked in Redis, briefly, and read exactly once.
 *
 * Why not the alternatives:
 * - **Store it on the order** — that undoes the hashing. A database leak would
 *   hand over every guest's order alongside the credential to reach it.
 * - **Stripe session metadata** — puts a bearer credential in a third party's
 *   logs and dashboard, permanently.
 * - **Send at checkout instead** — the order is not paid yet, and most
 *   unpaid checkouts never become orders.
 *
 * Deleted on read, and expires on its own if payment never comes. Losing it is
 * survivable: the email is simply sent without a tracking section, which is
 * exactly what a signed-in buyer gets anyway.
 */

/** Slightly longer than a Stripe Checkout session lives (24h). */
const TTL_SECONDS = 26 * 60 * 60;

const key = (orderId: number) => `order:guest-token:${orderId}`;

export async function stashGuestToken(orderId: number, rawToken: string): Promise<void> {
  await redis.set(key(orderId), rawToken, 'EX', TTL_SECONDS);
}

/**
 * Reads and destroys the token. Returns null when there is none — a signed-in
 * buyer, a redelivered webhook that already consumed it, or an expiry.
 */
export async function takeGuestToken(orderId: number): Promise<string | null> {
  const k = key(orderId);
  const token = await redis.get(k);
  if (token !== null) await redis.del(k);
  return token;
}
