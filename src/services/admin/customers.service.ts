import { and, desc, eq, gte, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { users, orders, refreshTokens } from '../../db/schema';

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
const orderCount = sql<number>`(select count(*) from orders o where o.user_id = ${users.id} and o.paid_at is not null)`;
const totalSpent = sql<number>`(select coalesce(sum(o.total_minor), 0) from orders o where o.user_id = ${users.id} and o.paid_at is not null)`;
const lastOrderAt = sql<Date | null>`(select max(o.paid_at) from orders o where o.user_id = ${users.id} and o.paid_at is not null)`;

export const adminCustomersService = {
  async list(query: AdminCustomerQuery) {
    // Every query on this screen is scoped to real customers. A browser the web
    // shop signed up so the cart would have a token is not someone the operator
    // can act on — it has no name, no reachable address and no order — and at
    // roughly ten per real signup they buried the people who are.
    const conditions: SQL[] = [countsAsCustomer];
    if (query.q) {
      const like = `%${query.q}%`;
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
   * Blocks an account.
   *
   * Deliberately reversible and deliberately non-destructive: it does not touch
   * their posts, reviews, shelf or order history. Moderation decisions get
   * revisited, and a blacklist that deletes content cannot be undone.
   *
   * What it does block is signing in and checking out — see the guards in
   * auth.service and commerce/checkout.service.
   */
  /**
   * @param tx Reuse the caller's transaction when there is one. Opening our own
   *   from inside another would take a *separate* connection under postgres-js,
   *   not a savepoint — so the two writes would not be atomic, and both trying
   *   to update the same `users` row would deadlock. Same pattern as
   *   subscriptions/state.service.
   */
  async blacklist(userId: number, adminId: number, reason: string | null, tx?: DbHandle) {
    // Blocking the account and ending its sessions are one decision, so they
    // are one transaction. Split, a crash between them leaves a customer marked
    // blacklisted while their existing sessions keep working — the exact state
    // the blacklist exists to prevent, and one nothing would ever re-check.
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
        .returning({ id: users.id, blacklistedAt: users.blacklistedAt });

      if (!updated) {
        // Either no such user or already blacklisted. Both are "nothing to do",
        // and the console should not care which.
        const [exists] = await handle
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (!exists) throw httpError('Customer not found', 404);
        return { id: userId, blacklisted: true, changed: false, sessionsRevoked: 0 };
      }

      // Kill every live session rather than waiting for one to lapse.
      //
    // The sign-in guards alone would leave a blacklisted user signed in until
    // their refresh token was next used — and since refreshing is itself
    // blocked, the practical effect without this is that they keep whatever
      // access token they were holding until it expires. Deleting the refresh
      // tokens means the next refresh has nothing to consume and the session ends
      // for good.
      //
    // Their current access token stays valid until it expires (15 minutes by
      // default). That window is why checkout carries its own blacklist check.
      const revoked = await handle
        .delete(refreshTokens)
        .where(eq(refreshTokens.userId, userId))
        .returning({ id: refreshTokens.id });

      return {
        id: updated.id,
        blacklisted: true,
        changed: true,
        sessionsRevoked: revoked.length,
      };
    };

    return tx ? run(tx) : db.transaction(run);
  },

  async unblacklist(userId: number) {
    const [updated] = await db
      .update(users)
      .set({ blacklistedAt: null, blacklistedBy: null, blacklistReason: null, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });

    if (!updated) throw httpError('Customer not found', 404);
    return { id: updated.id, blacklisted: false, changed: true };
  },
};
