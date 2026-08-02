import { redis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import type { SubscriptionTier, SubscriptionStatus } from '../../db/schema';
import { subscriptionStateService } from './state.service';

/**
 * "Is this user entitled to Plus right now?"
 *
 * Separate from state.service on purpose: that one owns *writing* subscription
 * state, this one owns the read that happens on nearly every authenticated
 * request. Hence the cache — the gate must not put a database round-trip in
 * front of every community post and bookshelf write.
 */

export interface Entitlement {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  isPlus: boolean;
}

// Short enough that a stale read can't outlive a user's patience after they
// pay, long enough to absorb a burst of requests from one client. Webhook
// writes invalidate explicitly, so this TTL is only a backstop.
const CACHE_TTL_SECONDS = 60;

const cacheKey = (userId: number): string => `entitlement:${userId}`;

const FREE: Entitlement = { tier: 'free', status: 'expired', isPlus: false };

export const entitlementsService = {
  async get(userId: number): Promise<Entitlement> {
    try {
      const cached = await redis.get(cacheKey(userId));
      if (cached) return JSON.parse(cached) as Entitlement;
    } catch (err) {
      // A Redis blip must not take the API down — fall through to the DB.
      logger.warn('Entitlement cache read failed, falling back to the database', {
        userId,
        error: (err as Error).message,
      });
    }

    // getCurrent also expires a due trial, so the answer is never based on a
    // trial that has already run out.
    const sub = await subscriptionStateService.getCurrent(userId);
    if (!sub) return FREE;

    const entitlement: Entitlement = {
      tier: sub.tier,
      status: sub.status,
      // past_due is intentionally still entitled — Stripe is retrying the card
      // and cutting access off on the first failure costs more than it saves.
      isPlus: sub.tier === 'plus' && sub.status !== 'expired' && sub.status !== 'incomplete',
    };

    try {
      await redis.setex(cacheKey(userId), CACHE_TTL_SECONDS, JSON.stringify(entitlement));
    } catch (err) {
      logger.warn('Entitlement cache write failed', { userId, error: (err as Error).message });
    }

    return entitlement;
  },

  /**
   * Drops the cached entitlement. Called after every write that could change
   * it, so a user who just paid isn't told to pay again for up to a minute.
   */
  async invalidate(userId: number): Promise<void> {
    try {
      await redis.del(cacheKey(userId));
    } catch (err) {
      logger.warn('Entitlement cache invalidation failed', {
        userId,
        error: (err as Error).message,
      });
    }
  },

  async isPlus(userId: number): Promise<boolean> {
    return (await this.get(userId)).isPlus;
  },
};
