import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { logger } from '../lib/logger';

/**
 * How stale `users.last_sign_in_at` is allowed to get before a request bothers
 * to move it. The console asks a 12-month question, so a day of drift is
 * invisible there — and it is the difference between one write per user per day
 * and one write per API call.
 */
const TOUCH_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Guard so the common case costs nothing. Without it every authenticated
 * request issues an UPDATE that almost always matches zero rows — cheap
 * individually, but it is a write on the hot path of every screen in the app,
 * and writes do not scale the way the reads around them do.
 *
 * Process-local on purpose. It is a de-duplication hint, not a source of truth:
 * the WHERE clause below is what actually enforces the throttle, so several
 * instances each waking once a day is correct, just marginally wasteful. A
 * shared cache would be real infrastructure to save one write per user per day.
 */
const lastTouched = new Map<number, number>();

/**
 * Bound on the map. Roughly "active users in a day" — past this we are holding
 * memory to save writes we are no longer making. Dropping the whole map costs
 * one extra UPDATE per user next time they appear, which the WHERE clause then
 * no-ops anyway if another instance got there first.
 */
const MAX_TRACKED_USERS = 50_000;

/**
 * Records that we have seen this account, for the admin console's
 * active/inactive split.
 *
 * Deliberately "last seen", not "last authenticated": it is called from the
 * auth middleware on any request carrying a valid token, not just from the
 * sign-in paths. With a 30-day refresh TTL and silent rotation, a daily mobile
 * user can go a year without re-entering a password — keyed on credential
 * entry, the people using the app most would be the ones reading as dormant.
 *
 * Fire-and-forget by contract. Callers must not await it and it never rejects:
 * failing somebody's request because we could not update an activity timestamp
 * would be a bad trade.
 */
export function touchLastSignIn(userId: number): void {
  const now = Date.now();
  const seen = lastTouched.get(userId);
  if (seen !== undefined && now - seen < TOUCH_THROTTLE_MS) return;

  // Recorded before the write resolves, so a burst of concurrent requests from
  // one client issues a single UPDATE rather than one per request in flight.
  lastTouched.set(userId, now);

  if (lastTouched.size > MAX_TRACKED_USERS) lastTouched.clear();

  void db
    .update(users)
    .set({ lastSignInAt: new Date() })
    // The real throttle. Also keeps this from touching `updated_at` semantics
    // or fighting another instance that just wrote the same value.
    .where(and(eq(users.id, userId), lt(users.lastSignInAt, new Date(now - TOUCH_THROTTLE_MS))))
    .catch((err: unknown) => {
      // Drop the guard so the next request retries rather than waiting out the
      // full throttle window on a transient failure.
      lastTouched.delete(userId);
      logger.warn('Failed to update last_sign_in_at', { error: (err as Error).message, userId });
    });
}

/**
 * Moves the timestamp unconditionally, for the paths that genuinely are a
 * sign-in (password, social, token refresh). Skips the throttle because those
 * are rare and because an explicit sign-in is exactly the event most worth
 * recording precisely.
 */
export async function recordSignIn(userId: number): Promise<void> {
  lastTouched.set(userId, Date.now());
  await db.update(users).set({ lastSignInAt: new Date() }).where(eq(users.id, userId));
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __resetActivityCache(): void {
  lastTouched.clear();
}
