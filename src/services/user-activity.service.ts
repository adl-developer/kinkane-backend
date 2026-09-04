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
 * memory to save writes we are no longer making.
 */
const MAX_TRACKED_USERS = 50_000;

/**
 * Records a sighting in the local guard.
 *
 * Deletes before setting so the Map's insertion order tracks *recency* rather
 * than first-sight — `set` on an existing key leaves its position alone, which
 * would make the eviction in `prune` shed whoever we happened to see first
 * rather than whoever we saw longest ago.
 */
function remember(userId: number, at: number): void {
  lastTouched.delete(userId);
  lastTouched.set(userId, at);
}

/**
 * Brings the map back under its bound.
 *
 * The first pass is free: an entry older than the throttle window no longer
 * suppresses anything, so dropping it loses nothing at all. Only if that is not
 * enough do we shed live guards, oldest first.
 *
 * The previous version cleared the whole map instead. That looked cheap but
 * stopped the throttle working exactly when it mattered: past the bound, every
 * one of the 50,000 tracked users — including the one whose request triggered
 * the clear — lost its guard at once and issued a redundant UPDATE on its next
 * request, over and over as the map refilled.
 */
function prune(now: number): void {
  for (const [id, at] of lastTouched) {
    // Insertion order is recency order, so the first live entry means every
    // entry behind it is live too.
    if (now - at < TOUCH_THROTTLE_MS) break;
    lastTouched.delete(id);
  }

  while (lastTouched.size > MAX_TRACKED_USERS) {
    const oldest = lastTouched.keys().next();
    if (oldest.done) break;
    lastTouched.delete(oldest.value);
  }
}

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
  remember(userId, now);

  if (lastTouched.size > MAX_TRACKED_USERS) prune(now);

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

/** Test seam — the module-level cache would otherwise leak between cases. */
export function __resetActivityCache(): void {
  lastTouched.clear();
}
