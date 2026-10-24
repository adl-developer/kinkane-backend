import { and, desc, eq, gte, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { users, orders, refreshTokens } from '../../db/schema';
import { likeContains } from '../../lib/escape-like';
import { enqueueEmail } from '../../lib/email-queue';
import { ensureKinkaneAdmin, KINKANE_ADMIN_EMAIL } from '../kinkane-admin';
import { handOverOwnedGroups } from '../groups.service';
import { forgetStanding } from '../blocks.service';
import { logger } from '../../lib/logger';

/** Either the pool or an open transaction, so callers can share one. */
type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
import { ACTIVE_CUSTOMER_WINDOW_DAYS, countsAsCustomer } from './dashboard.service';

export interface AdminCustomerQuery {
  q?: string;
  limit: number;
  offset: number;
}

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

// Every per-customer aggregate the screen needs, computed once. Correlated
// subqueries rather than a join + GROUP BY: the page is at most 50 customers,
// and grouping the whole orders table to render 50 rows is the wrong shape.
//
// The customer's id is spelled out rather than interpolated as `users.id`. In a
// select with no joins, Drizzle prints select-list columns without their table,
// so `${users.id}` became a bare "id" — which inside `from orders o` means
// `o.id`. Every customer's figures were silently counted against orders whose
// own id happened to equal their user_id.
const customerId = sql.raw('"users"."id"');
const orderCount = sql<number>`(select count(*) from orders o where o.user_id = ${customerId} and o.paid_at is not null)`;
const totalSpent = sql<number>`(select coalesce(sum(o.total_minor), 0) from orders o where o.user_id = ${customerId} and o.paid_at is not null)`;
const lastOrderAt = sql<Date | null>`(select max(o.paid_at) from orders o where o.user_id = ${customerId} and o.paid_at is not null)`;

export const adminCustomersService = {
  async list(query: AdminCustomerQuery) {
    // Every query on this screen is scoped to real customers. A browser the web
    // shop signed up so the cart would have a token is not someone the operator
    // can act on — it has no name, no reachable address and no order — and at
    // roughly ten per real signup they buried the people who are.
    const conditions: SQL[] = [countsAsCustomer];
    if (query.q) {
      // Escaped, so a `%` or `_` in the search box matches literally instead
      // of acting as a wildcard.
      const like = likeContains(query.q);
      conditions.push(or(ilike(users.name, like), ilike(users.email, like))!);
    }
    const where = and(...conditions);

    const activeSince = new Date(Date.now() - ACTIVE_CUSTOMER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [rows, [total], [stats]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          countryCode: users.countryCode,
          joinedAt: users.createdAt,
          blacklistedAt: users.blacklistedAt,
          blacklistReason: users.blacklistReason,
          orders: orderCount,
          totalSpentMinor: totalSpent,
          lastOrderAt,
          lastSignInAt: users.lastSignInAt,
          isGuest: users.isGuest,
        })
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ n: sql<number>`count(*)` }).from(users).where(where),
      // The three cards. Unfiltered on purpose — they describe the whole
      // customer base, not the current search, which is what the design shows.
      db
        .select({
          total: sql<number>`count(*)`,
          blacklisted: sql<number>`count(*) filter (where ${users.blacklistedAt} is not null)`,
        })
        .from(users)
        .where(countsAsCustomer),
    ]);

    const [[active], [spend]] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)` })
        .from(users)
        .where(and(gte(users.lastSignInAt, activeSince), countsAsCustomer)),
      db
        .select({ minor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)` })
        .from(orders)
        .where(isNotNull(orders.paidAt)),
    ]);

    const totalCustomers = Number(stats.total);
    const activeCustomers = Number(active.n);

    return {
      customers: rows.map((r) => ({
        ...r,
        orders: Number(r.orders),
        totalSpentMinor: Number(r.totalSpentMinor),
        // "Active" is: seen in the last 12 months. Engagement, not spend — a
        // reader who signs in every week and has never bought a book is a live
        // account, and the previous rule (paid in the last 12 months) filed them
        // with the abandoned ones. Purchase history is still right there in
        // `orders`/`totalSpentMinor` for anyone asking the revenue question.
        active: new Date(r.lastSignInAt) >= activeSince,
        blacklisted: r.blacklistedAt !== null,
      })),
      total: Number(total.n),
      stats: {
        customers: totalCustomers,
        active: activeCustomers,
        inactive: Math.max(0, totalCustomers - activeCustomers),
        blacklisted: Number(stats.blacklisted),
        totalSpentMinor: Number(spend.minor),
      },
    };
  },

  /**
   * Blacklists an account: it can no longer sign in or buy, and its profile
   * and community activity disappear for everyone else.
   *
   * Every way in is closed — password, social sign-in and refresh (see the
   * guards in auth.service) — and live sessions are ended here. Checkout
   * refuses them too, as a guest with the same email included (see
   * commerce/checkout.service), and the community routes refuse whatever is
   * left of their current access token (see requireCommunityAccess). Their
   * activity is hidden through accountActive. Groups they own pass to the
   * Kinkané Admin house account (see handOverOwnedGroups), and stay there if
   * the blacklist is lifted: an admin hands them back by hand if they want to.
   *
   * Deliberately reversible and non-destructive: nothing is deleted, so
   * lifting it brings everything back. Moderation decisions get revisited, and
   * a blacklist that destroyed content could not be undone.
   *
   * They are emailed when it lands, by the caller once the change is committed.
   *
   * @param tx Reuse the caller's transaction when there is one. Opening our own
   *   from inside another would take a *separate* connection under postgres-js,
   *   not a savepoint — so the two writes would not be atomic, and both trying
   *   to update the same `users` row would deadlock. Same pattern as
   *   subscriptions/state.service.
   */
  async blacklist(userId: number, adminId: number, reason: string | null, tx?: DbHandle) {
    // Blocking the account and ending its sessions are one decision, so they
    // are one transaction. Split, a crash between them leaves a customer marked
    // blacklisted while their existing sessions keep working.
    //
    // The `isNull` in the WHERE is also what makes this idempotent under
    // concurrency: two admins clicking at once, and only one update lands.
    const run = async (handle: DbHandle) => {
      const [updated] = await handle
        .update(users)
        .set({
          blacklistedAt: new Date(),
          blacklistedBy: adminId,
          blacklistReason: reason,
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, userId), isNull(users.blacklistedAt)))
        .returning({ id: users.id, email: users.email, name: users.name });

      if (!updated) {
        // Either no such user or already blacklisted. Both are "nothing to do",
        // and the console should not care which.
        const [exists] = await handle.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
        if (!exists) throw httpError('Customer not found', 404);
        return { id: userId, blacklisted: true, changed: false, sessionsRevoked: 0 };
      }

      // Their clubs carry on under the house account, in the same transaction:
      // a blacklist that landed without the handover would leave groups owned
      // by someone who has vanished. Never the house account handing to itself.
      const adminUserId = await ensureKinkaneAdmin(handle);
      const handedOverGroups = adminUserId === userId ? [] : await handOverOwnedGroups(handle, userId, adminUserId);

      // Kill every live session rather than waiting for one to lapse. With
      // refreshing refused, deleting the refresh tokens ends each session at
      // its next refresh; the access token in hand stays valid until it
      // expires (15 minutes by default), which is why checkout and the
      // community routes carry their own checks.
      const revoked = await handle
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, userId))
        .returning({ id: refreshTokens.id });

      return {
        id: updated.id,
        blacklisted: true,
        changed: true,
        sessionsRevoked: revoked.length,
        email: updated.email,
        name: updated.name,
        handedOverGroups,
      };
    };

    const result = await (tx ? run(tx) : db.transaction(run));
    // This instance's community guard answers at once; others within a minute.
    forgetStanding(userId);
    return result;
  },

  /**
   * Emails a newly blacklisted account, and tells the house inbox about any
   * groups that passed to Kinkané Admin. Never throws: the blacklist stands
   * either way.
   */
  async notifyBlacklisted(result: {
    changed: boolean;
    email?: string;
    name?: string;
    handedOverGroups?: { id: number; name: string }[];
  }) {
    if (!result.changed || !result.email) return;
    try {
      await enqueueEmail('account-blacklisted', { to: result.email, name: result.name ?? '' });
      if (result.handedOverGroups?.length) {
        await enqueueEmail('groups-handed-over', {
          to: KINKANE_ADMIN_EMAIL,
          formerOwnerName: result.name ?? '',
          formerOwnerEmail: result.email,
          groups: result.handedOverGroups,
        });
      }
    } catch (err) {
      logger.error('Failed to enqueue blacklist emails', { error: (err as Error).message });
    }
  },

  async unblacklist(userId: number) {
    const [updated] = await db
      .update(users)
      .set({ blacklistedAt: null, blacklistedBy: null, blacklistReason: null, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (!updated) throw httpError('Customer not found', 404);
    forgetStanding(userId);
    return { id: updated.id, blacklisted: false, changed: true };
  },
};
