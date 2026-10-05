import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Shared by the Stripe webhook and the App Store notification endpoint, which
 * both claim each delivery by id before handling it (insert, or on conflict
 * re-take an abandoned claim).
 *
 * How long a claim can hold before it's considered abandoned and re-runnable.
 * Set to comfortably longer than any handler could plausibly take (the slowest
 * involve a small handful of Stripe or App Store API calls, well under 30s), and
 * shorter than either provider's redelivery cadence, so a still-running
 * instance is never preempted by a redelivery that races with it.
 */
export const STALE_CLAIM_SECONDS = 60;

/**
 * The `setWhere` for an insert-or-reclaim: an existing delivery row may be
 * claimed again only if its handler never finished and the claim has gone stale.
 */
export function reclaimableClaim(processedAt: PgColumn, receivedAt: PgColumn): SQL {
  return sql`${processedAt} IS NULL AND ${receivedAt} < now() - interval '${sql.raw(String(STALE_CLAIM_SECONDS))} seconds'`;
}
