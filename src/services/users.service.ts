import { eq, and, sql, asc, desc } from 'drizzle-orm';
import { db } from '../db';
import { users, posts, followRequests, userBooks, books } from '../db/schema';
import { enqueueEmail } from '../lib/email-queue';
import { logger } from '../lib/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FollowStatus = 'none' | 'pending' | 'accepted' | 'declined';
export type ShelfFilter = 'all' | 'want_to_read' | 'reading' | 'read';
export type ShelfSort = 'date_desc' | 'date_asc' | 'title_asc' | 'title_desc';

export interface ShelfItem {
  id: number;
  bookId: number;
  title: string;
  coverUrl: string | null;
  status: string;
  addedAt: Date;
}

export interface PendingFollowRequest {
  id: number;
  name: string;
  photoUrl: string | null;
}

export interface FollowListItem {
  id: number;
  name: string;
  photoUrl: string | null;
}

export interface UserProfile {
  id: number;
  name: string;
  photoUrl: string | null;
  yearJoined: number;
  followStatus: FollowStatus;
  // Only present for accepted followers
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertFound<T>(row: T | undefined, label: string): T {
  if (!row) throw Object.assign(new Error(`${label} not found`), { statusCode: 404 });
  return row;
}

function toFollowStatus(status: string | null | undefined): FollowStatus {
  if (status === 'accepted') return 'accepted';
  if (status === 'pending') return 'pending';
  if (status === 'declined') return 'declined';
  return 'none';
}

/**
 * Guards access to a user's follower/following list with the same rule as
 * their follower/following counts on the profile: visible to themselves or
 * to anyone who is already an accepted follower of them. 404 (not 403) to
 * avoid revealing the account exists to someone who can't see it.
 */
async function assertCanViewFollowGraph(targetId: number, requesterId: number): Promise<void> {
  if (targetId === requesterId) return;

  const [[targetUser], [followRow]] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).limit(1),
    db
      .select({ status: followRequests.status })
      .from(followRequests)
      .where(and(eq(followRequests.senderId, requesterId), eq(followRequests.receiverId, targetId)))
      .limit(1),
  ]);

  if (!targetUser || followRow?.status !== 'accepted') {
    throw Object.assign(new Error('User not found'), { statusCode: 404 });
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export const usersService = {
  async getUserProfile(targetId: number, requesterId: number): Promise<UserProfile> {
    if (targetId === requesterId) {
      throw Object.assign(new Error('Cannot view your own profile via this endpoint'), { statusCode: 400 });
    }

    // Fetch user row and requester's follow status in parallel
    const [[userRow], [followRow]] = await Promise.all([
      db
        .select({ id: users.id, name: users.name, photoUrl: users.photoUrl, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1),
      db
        .select({ status: followRequests.status })
        .from(followRequests)
        .where(and(eq(followRequests.senderId, requesterId), eq(followRequests.receiverId, targetId)))
        .limit(1),
    ]);

    assertFound(userRow, 'User');

    const followStatus = toFollowStatus(followRow?.status);

    const base: UserProfile = {
      id: userRow.id,
      name: userRow.name,
      photoUrl: userRow.photoUrl ?? null,
      yearJoined: new Date(userRow.createdAt).getFullYear(),
      followStatus,
    };

    // Non-followers see only the base profile (name, photo, year joined, follow status)
    if (followStatus !== 'accepted') {
      return base;
    }

    // Accepted followers get full counts. Collapse follower+following into one query.
    const [[followCounts], [postCountRow]] = await Promise.all([
      db
        .select({
          followerCount: sql<number>`SUM(CASE WHEN ${followRequests.receiverId} = ${targetId} THEN 1 ELSE 0 END)::int`,
          followingCount: sql<number>`SUM(CASE WHEN ${followRequests.senderId} = ${targetId} THEN 1 ELSE 0 END)::int`,
        })
        .from(followRequests)
        .where(
          and(
            eq(followRequests.status, 'accepted'),
            sql`(${followRequests.receiverId} = ${targetId} OR ${followRequests.senderId} = ${targetId})`,
          ),
        ),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(posts)
        .where(and(eq(posts.userId, targetId), eq(posts.isPublic, true))),
    ]);

    return {
      ...base,
      followerCount: followCounts?.followerCount ?? 0,
      followingCount: followCounts?.followingCount ?? 0,
      postCount: postCountRow?.count ?? 0,
    };
  },

  /**
   * Lists pending incoming follow requests for the authenticated user —
   * i.e. people who have requested to follow them, newest first. Paginated
   * since a spammed account could otherwise accumulate an unbounded number
   * of pending requests.
   */
  async listPendingFollowRequests(
    receiverId: number,
    limit: number,
    offset: number,
  ): Promise<{ items: PendingFollowRequest[]; total: number }> {
    const [rows, [countRow]] = await Promise.all([
      db
        .select({ id: followRequests.id, name: users.name, photoUrl: users.photoUrl })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.senderId))
        .where(and(eq(followRequests.receiverId, receiverId), eq(followRequests.status, 'pending')))
        .orderBy(desc(followRequests.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(followRequests)
        .where(and(eq(followRequests.receiverId, receiverId), eq(followRequests.status, 'pending'))),
    ]);

    return { items: rows, total: countRow?.count ?? 0 };
  },

  /**
   * Lists a user's accepted followers (people following them), newest first.
   * Same visibility gating as getUserProfile's follower count — the requester
   * must be viewing their own list or already be an accepted follower of the target.
   */
  async listFollowers(
    targetId: number,
    requesterId: number,
    limit: number,
    offset: number,
  ): Promise<{ items: FollowListItem[]; total: number }> {
    await assertCanViewFollowGraph(targetId, requesterId);

    const [rows, [countRow]] = await Promise.all([
      db
        .select({ id: users.id, name: users.name, photoUrl: users.photoUrl })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.senderId))
        .where(and(eq(followRequests.receiverId, targetId), eq(followRequests.status, 'accepted')))
        .orderBy(desc(followRequests.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(followRequests)
        .where(and(eq(followRequests.receiverId, targetId), eq(followRequests.status, 'accepted'))),
    ]);

    return { items: rows, total: countRow?.count ?? 0 };
  },

  /**
   * Lists the users a given user is following (accepted), newest first.
   * Same visibility gating as listFollowers.
   */
  async listFollowing(
    targetId: number,
    requesterId: number,
    limit: number,
    offset: number,
  ): Promise<{ items: FollowListItem[]; total: number }> {
    await assertCanViewFollowGraph(targetId, requesterId);

    const [rows, [countRow]] = await Promise.all([
      db
        .select({ id: users.id, name: users.name, photoUrl: users.photoUrl })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.receiverId))
        .where(and(eq(followRequests.senderId, targetId), eq(followRequests.status, 'accepted')))
        .orderBy(desc(followRequests.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(followRequests)
        .where(and(eq(followRequests.senderId, targetId), eq(followRequests.status, 'accepted'))),
    ]);

    return { items: rows, total: countRow?.count ?? 0 };
  },

  async sendFollowRequest(senderId: number, receiverId: number): Promise<void> {
    if (senderId === receiverId) {
      throw Object.assign(new Error('Cannot follow yourself'), { statusCode: 400 });
    }

    // Fetch sender and receiver in parallel — fail early with distinct labels
    const [[sender], [target]] = await Promise.all([
      db
        .select({ name: users.name, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, senderId))
        .limit(1),
      db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, receiverId))
        .limit(1),
    ]);

    assertFound(sender, 'Sender');
    assertFound(target, 'Target user');

    if (!sender.emailVerified) {
      throw Object.assign(new Error('Please verify your email before sending follow requests'), { statusCode: 403 });
    }

    // Check for an existing request
    const [existing] = await db
      .select({ id: followRequests.id, status: followRequests.status })
      .from(followRequests)
      .where(and(eq(followRequests.senderId, senderId), eq(followRequests.receiverId, receiverId)))
      .limit(1);

    if (existing) {
      if (existing.status === 'pending') {
        throw Object.assign(new Error('Follow request already sent'), { statusCode: 409 });
      }
      if (existing.status === 'accepted') {
        throw Object.assign(new Error('You are already following this user'), { statusCode: 409 });
      }
      // status === 'declined' — re-send by resetting to pending
      await db
        .update(followRequests)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(followRequests.id, existing.id));
    } else {
      // onConflictDoNothing handles the concurrent-insert race; the first request wins
      const [inserted] = await db
        .insert(followRequests)
        .values({ senderId, receiverId })
        .onConflictDoNothing()
        .returning({ id: followRequests.id });

      if (!inserted) {
        // Another concurrent request already created this follow request
        throw Object.assign(new Error('Follow request already sent'), { statusCode: 409 });
      }
    }

    enqueueEmail('follow-request', {
      to: target.email,
      receiverName: target.name,
      senderName: sender.name,
    }).catch((err) => logger.error('Failed to enqueue follow-request email', { err }));
  },

  async withdrawFollowRequest(senderId: number, receiverId: number): Promise<void> {
    const result = await db
      .delete(followRequests)
      .where(
        and(
          eq(followRequests.senderId, senderId),
          eq(followRequests.receiverId, receiverId),
          eq(followRequests.status, 'pending'),
        ),
      )
      .returning({ id: followRequests.id });

    if (result.length === 0) {
      throw Object.assign(new Error('No pending follow request found'), { statusCode: 404 });
    }
  },

  async acceptFollowRequest(requestId: number, receiverId: number): Promise<void> {
    const [existing] = await db
      .select({ id: followRequests.id, senderId: followRequests.senderId })
      .from(followRequests)
      .where(
        and(
          eq(followRequests.id, requestId),
          eq(followRequests.receiverId, receiverId),
          eq(followRequests.status, 'pending'),
        ),
      )
      .limit(1);

    if (!existing) {
      throw Object.assign(new Error('Follow request not found'), { statusCode: 404 });
    }

    await db
      .update(followRequests)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(followRequests.id, requestId));

    const [[sender], [receiver]] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, existing.senderId)).limit(1),
      db.select({ name: users.name }).from(users).where(eq(users.id, receiverId)).limit(1),
    ]);

    if (sender && receiver) {
      enqueueEmail('follow-accepted', {
        to: sender.email,
        senderName: sender.name,
        accepterName: receiver.name,
      }).catch((err) => logger.error('Failed to enqueue follow-accepted email', { err }));
    } else {
      logger.warn('Skipped follow-accepted email — user(s) not found after accept', {
        requestId,
        senderId: existing.senderId,
        receiverId,
        senderFound: !!sender,
        receiverFound: !!receiver,
      });
    }
  },

  async declineFollowRequest(requestId: number, receiverId: number): Promise<void> {
    const result = await db
      .update(followRequests)
      .set({ status: 'declined', updatedAt: new Date() })
      .where(
        and(
          eq(followRequests.id, requestId),
          eq(followRequests.receiverId, receiverId),
          eq(followRequests.status, 'pending'),
        ),
      )
      .returning({ id: followRequests.id });

    if (result.length === 0) {
      throw Object.assign(new Error('Follow request not found'), { statusCode: 404 });
    }
  },

  async getUserBooks(
    targetId: number,
    requesterId: number,
    filter: ShelfFilter,
    sort: ShelfSort,
    limit: number,
    offset: number,
  ): Promise<{ items: ShelfItem[]; total: number }> {
    // Fetch target's shelf visibility and the requester's follow status in parallel
    const [[targetUser], [followRow]] = await Promise.all([
      db
        .select({ shelfVisibility: users.shelfVisibility })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1),
      db
        .select({ status: followRequests.status })
        .from(followRequests)
        .where(and(eq(followRequests.senderId, requesterId), eq(followRequests.receiverId, targetId)))
        .limit(1),
    ]);

    if (!targetUser) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    const isSelf = targetId === requesterId;
    const isAcceptedFollower = followRow?.status === 'accepted';
    const { shelfVisibility } = targetUser;

    if (shelfVisibility === 'private' && !isSelf) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }
    if (shelfVisibility === 'friends' && !isSelf && !isAcceptedFollower) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    const conditions = [eq(userBooks.userId, targetId)];
    if (filter !== 'all') {
      conditions.push(eq(userBooks.status, filter));
    }
    const where = and(...conditions);

    const orderBy = {
      date_desc: desc(userBooks.addedAt),
      date_asc:  asc(userBooks.addedAt),
      title_asc: asc(books.title),
      title_desc: desc(books.title),
    }[sort];

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: userBooks.id,
          bookId: userBooks.bookId,
          title: books.title,
          coverUrl: books.coverUrl,
          status: userBooks.status,
          addedAt: userBooks.addedAt,
        })
        .from(userBooks)
        .innerJoin(books, eq(books.id, userBooks.bookId))
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userBooks)
        .where(where),
    ]);

    return { items: rows, total: countRow?.count ?? 0 };
  },
};
