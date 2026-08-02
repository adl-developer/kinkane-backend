import { describe, it, expect, beforeEach, vi } from 'vitest';
import { userSubscriptions, subscriptionEvents, subscriptionStateHistory } from '../db/schema';
import type { UserSubscription } from '../db/schema';
// vi.mock is hoisted above these imports, so the service picks up the mocked db.
import { subscriptionStateService } from '../services/subscriptions/state.service';

/**
 * Guards on subscriptionStateService.expireTrialIfDue.
 *
 * This flip used to be written out twice — once in getMe, once in the hourly
 * cron — with different levels of safety. The getMe copy updated by primary key
 * with no re-check, so a Stripe webhook landing between its read and its write
 * was silently overwritten: the user paid, and their own next request downgraded
 * them to free. These tests exist to keep that from coming back.
 */

// The result the conditional UPDATE will return. Empty array = the guards
// didn't match, i.e. someone else got there first.
let updateResult: unknown[] = [];
const insertedRows: Array<{ table: unknown; values: unknown }> = [];
let updateCalls = 0;

function chainableUpdate() {
  updateCalls += 1;
  const chain = {
    set: () => chain,
    where: () => chain,
    returning: async () => updateResult,
    then: undefined,
  };
  return chain;
}

function fakeTx() {
  return {
    update: () => chainableUpdate(),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        insertedRows.push({ table, values });
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          // No open history interval — recordHistory then just inserts one.
          limit: async () => [],
        }),
      }),
    }),
  };
}

vi.mock('../db', () => ({
  db: {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx()),
    update: () => chainableUpdate(),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        insertedRows.push({ table, values });
      },
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  },
}));


const HOUR = 60 * 60 * 1000;

function subscription(overrides: Partial<UserSubscription> = {}): UserSubscription {
  return {
    id: 1,
    userId: 42,
    tier: 'plus',
    status: 'trialing',
    trialEndsAt: new Date(Date.now() - HOUR),
    trialExpiredAt: null,
    plan: null,
    priceId: null,
    isFoundingMember: false,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as UserSubscription;
}

const eventsInserted = () => insertedRows.filter((r) => r.table === subscriptionEvents);
const historyInserted = () => insertedRows.filter((r) => r.table === subscriptionStateHistory);

beforeEach(() => {
  insertedRows.length = 0;
  updateCalls = 0;
  updateResult = [];
});

describe('expireTrialIfDue', () => {
  it('does nothing while the trial is still running', async () => {
    const result = await subscriptionStateService.expireTrialIfDue(
      subscription({ trialEndsAt: new Date(Date.now() + HOUR) }),
    );

    expect(result).toBeNull();
    expect(updateCalls).toBe(0);
    expect(eventsInserted()).toHaveLength(0);
  });

  it('does nothing for a subscription that is not trialing', async () => {
    const result = await subscriptionStateService.expireTrialIfDue(
      subscription({ status: 'active' }),
    );

    expect(result).toBeNull();
    expect(updateCalls).toBe(0);
  });

  // The core regression: a user who converted to paid must never be downgraded
  // by the trial sweep, no matter what their trial_ends_at says.
  it('refuses to expire a trial once Stripe billing is attached', async () => {
    updateResult = [subscription()];

    const result = await subscriptionStateService.expireTrialIfDue(
      subscription({ stripeSubscriptionId: 'sub_123' }),
    );

    expect(result).toBeNull();
    expect(updateCalls).toBe(0);
    expect(eventsInserted()).toHaveLength(0);
  });

  it('expires a due trial and records exactly one event', async () => {
    const expired = subscription({ tier: 'free', status: 'expired' });
    updateResult = [expired];

    const result = await subscriptionStateService.expireTrialIfDue(subscription());

    expect(result).toEqual(expired);
    expect(eventsInserted()).toHaveLength(1);
    expect((eventsInserted()[0].values as { event: string }).event).toBe('expired');
    // The state timeline gets a new interval too, not just the audit event.
    expect(historyInserted()).toHaveLength(1);
  });

  // Two concurrent callers — the cron in one process, getMe in another — must
  // not both log an expiry. The loser's UPDATE matches no rows, and everything
  // downstream of it is skipped.
  it('logs nothing when another writer won the race', async () => {
    updateResult = [];

    const result = await subscriptionStateService.expireTrialIfDue(subscription());

    expect(result).toBeNull();
    expect(updateCalls).toBe(1);
    expect(eventsInserted()).toHaveLength(0);
    expect(historyInserted()).toHaveLength(0);
  });
});
