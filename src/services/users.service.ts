import { eq, and, isNull, sql, asc, desc } from 'drizzle-orm';
import { db, type Tx } from '../db';
import { users, posts, followRequests, userBooks, books, notifications, ShelfVisibility } from '../db/schema';
import { enqueueEmail } from '../lib/email-queue';
import { enqueuePush } from '../lib/push-queue';
import { notificationPreferencesService } from './notification-preferences.service';
import { logger } from '../lib/logger';
import { blockStateBetween, blockedBetween, blockedError } from './blocks.service';

// ── Friend-request notifications ──────────────────────────────────────────────
// Each follow request has exactly one `friend_request` notification for its
// receiver (unique on follow_request_id). These helpers run inside the same
// transaction as the follow-request write so the two can never disagree;
// withdrawal needs no helper because the FK cascade deletes the row.

/** Creates the request's notification, or revives it as unread at the top of the feed on a resend. */
async function upsertFriendRequestNotification(
  tx: Tx,
  request: { id: number; receiverId: number; senderId: number; senderName: string; senderPhotoUrl: string | null },
): Promise<void> {
  const data = {
    followRequestId: request.id,
    senderId: request.senderId,
    senderName: request.senderName,
    senderPhotoUrl: request.senderPhotoUrl,
    status: 'pending',
  };
  await tx
    .insert(notifications)
    .values({ userId: request.receiverId, type: 'friend_request', followRequestId: request.id, data })
    .onConflictDoUpdate({
      target: notifications.followRequestId,
      set: { data, readAt: null, createdAt: new Date() },
    });
}

/** Mirrors an accept/decline onto the notification. Acting on a request also counts as reading it. */
async function setFriendRequestNotificationStatus(
  tx: Tx,
  requestId: number,
  status: 'accepted' | 'declined',
): Promise<void> {
  await tx
    .update(notifications)
    .set({
      data: sql`jsonb_set(${notifications.data}, '{status}', to_jsonb(${status}::text))`,
      readAt: sql`COALESCE(${notifications.readAt}, now())`,
    })
    .where(eq(notifications.followRequestId, requestId));
}

// ── Types ─────────────────────────────────────────────────────────────────────

// 'blocked' only ever describes a block the viewer placed: the profile's Follow
// button reads "Blocked". It is never stored on a follow request.
export type FollowStatus = 'none' | 'pending' | 'accepted' | 'declined' | 'blocked';
// 'liked' is the Favourites section and 'owned' the Owned one; both are flags
// on top of the reading status, so a book can turn up under more than one.
export type ShelfFilter = 'all' | 'want_to_read' | 'reading' | 'read' | 'liked' | 'owned';
export type ShelfSort = 'date_desc' | 'date_asc' | 'title_asc' | 'title_desc';

export interface ShelfItem {
  id: number;
  bookId: number;
  title: string;
  coverUrl: string | null;
  status: string | null;
  liked: boolean;
  owned: boolean;
  addedAt: Date;
}

export type FollowRequestDirection = 'incoming' | 'outgoing';

export interface PendingFollowRequest {
  /** The follow-request id — what the accept/decline endpoints take. */
  id: number;
  /**
   * The *other* user: the sender for incoming requests, the receiver for
   * outgoing ones. Withdrawing an outgoing request needs this, not the id above.
   */
  userId: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
}

export interface FollowListItem {
  id: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
}

export interface UserProfile {
  id: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
  yearJoined: number;
  /** Full sign-up timestamp; yearJoined is kept for older app builds. */
  joinedAt: Date;
  followStatus: FollowStatus;
  // A pending request *they* sent *you*, for Accept/Decline. It doesn't stop
  // you sending your own request to them; the two are independent.
  incomingFollowRequest: { requestId: number; requestedAt: Date } | null;
  shelfVisibility: ShelfVisibility;
  // Whether the requester may read this user's whole shelf. Decided here so
  // clients never re-implement the visibility rule; see canViewShelf below.
  canViewShelf: boolean;
  // A block between the two, by direction. Either one makes this the limited
  // profile — name, photo and join date only, no counts, no shelf — and rules
  // out following. Only the blocker can unblock, so the app shows Unblock for
  // isBlocked and nothing for hasBlockedYou.
  isBlocked: boolean;
  hasBlockedYou: boolean;
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

export function toFollowStatus(status: string | null | undefined): FollowStatus {
  if (status === 'accepted') return 'accepted';
  if (status === 'pending') return 'pending';
  if (status === 'declined') return 'declined';
  return 'none';
}

interface FollowRequestRow {
  id: number;
  status: FollowStatus;
}

export type FollowRequestDecision =
  | { action: 'insert' }
  | { action: 'resend'; requestId: number }
  | { action: 'reject'; message: string };

/**
 * What sending a follow request should do, given the caller's own request to
 * the target. Only the caller's side matters: follows go one way, so a request
 * the target has sent the caller — pending or not — is a separate relationship
 * and never blocks this one. Both can be pending at once.
 */
export function decideFollowRequest(outgoing: FollowRequestRow | undefined): FollowRequestDecision {
  if (outgoing?.status === 'pending') {
    return { action: 'reject', message: 'Follow request already sent' };
  }
  if (outgoing?.status === 'accepted') {
    return { action: 'reject', message: 'You are already following this user' };
  }
  // A declined request of the caller's own is re-sent by resetting it to pending.
  if (outgoing?.status === 'declined') return { action: 'resend', requestId: outgoing.id };
  return { action: 'insert' };
}

/** Who the target is, and what the requester is to them. */
interface ViewerRelationship {
  target: {
    id: number;
    name: string;
    username: string | null;
    photoUrl: string | null;
    createdAt: Date;
    shelfVisibility: ShelfVisibility;
  };
  isSelf: boolean;
  /** The requester's own follow request to the target, if any. */
  followStatus: FollowStatus;
  isAcceptedFollower: boolean;
  /** A block between the two, either way. Hides everything past the limited profile. */
  blocked: boolean;
}

/**
 * The target user and the requester's follow request to them, in one query.
 * Every "may this person see that" check in this file starts here, so they
 * all read the follow graph the same way. Null when the target doesn't exist.
 */
async function loadViewerRelationship(targetId: number, requesterId: number): Promise<ViewerRelationship | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      photoUrl: users.photoUrl,
      createdAt: users.createdAt,
      shelfVisibility: users.shelfVisibility,
      followStatus: followRequests.status,
      blocked: blockedBetween(requesterId, users.id).mapWith(Boolean),
    })
    .from(users)
    .leftJoin(
      followRequests,
      and(eq(followRequests.senderId, requesterId), eq(followRequests.receiverId, users.id)),
    )
    // A blacklisted account is gone for everyone else — profile, shelf, follow
    // lists — and answers exactly as a missing one does.
    .where(and(eq(users.id, targetId), targetId === requesterId ? undefined : isNull(users.blacklistedAt)))
    .limit(1);
  if (!row) return null;

  const { followStatus: rawStatus, blocked, ...target } = row;
  const followStatus = toFollowStatus(rawStatus);
  return {
    target,
    isSelf: targetId === requesterId,
    followStatus,
    isAcceptedFollower: followStatus === 'accepted',
    blocked,
  };
}

function userNotFound(): Error {
  return Object.assign(new Error('User not found'), { statusCode: 404 });
}

/**
 * Guards access to a user's follower/following list with the same rule as
 * their follower/following counts on the profile: visible to themselves or
 * to anyone who is already an accepted follower of them. 404 (not 403) to
 * avoid revealing the account exists to someone who can't see it.
 */
async function assertCanViewFollowGraph(targetId: number, requesterId: number): Promise<void> {
  if (targetId === requesterId) return;
  const relationship = await loadViewerRelationship(targetId, requesterId);
  if (!relationship?.isAcceptedFollower || relationship.blocked) throw userNotFound();
}

/**
 * The shelf visibility rule: `public` to everyone, `friends` to themselves and
 * accepted followers, `private` to themselves only.
 */
export function canViewShelf(
  visibility: ShelfVisibility,
  isSelf: boolean,
  isAcceptedFollower: boolean,
): boolean {
  if (isSelf) return true;
  if (visibility === 'public') return true;
  if (visibility === 'friends') return isAcceptedFollower;
  return false;
}

/**
 * One book off someone's shelf is looser than the whole shelf: accepted
 * followers always get it, whatever the shelf setting, because a single book
 * reveals far less than the full list. Everyone else follows canViewShelf.
 */
export function canViewShelfBook(
  visibility: ShelfVisibility,
  isSelf: boolean,
  isAcceptedFollower: boolean,
): boolean {
  return isAcceptedFollower || canViewShelf(visibility, isSelf, isAcceptedFollower);
}

/**
 * Guards a read off a user's shelf with `rule` — canViewShelf for the whole
 * shelf, canViewShelfBook for one book. 404 (not 403), like the follow graph,
 * so a hidden shelf looks the same as a missing account.
 */
export async function assertCanViewShelf(
  targetId: number,
  requesterId: number,
  rule: typeof canViewShelf = canViewShelf,
): Promise<void> {
  const relationship = await loadViewerRelationship(targetId, requesterId);
  if (!relationship) throw userNotFound();
  const { target, isSelf, isAcceptedFollower, blocked } = relationship;
  if (blocked || !rule(target.shelfVisibility, isSelf, isAcceptedFollower)) throw userNotFound();
}

// ── Service ───────────────────────────────────────────────────────────────────

export const usersService = {
  async getUserProfile(targetId: number, requesterId: number): Promise<UserProfile> {
    if (targetId === requesterId) {
      throw Object.assign(new Error('Cannot view your own profile via this endpoint'), { statusCode: 400 });
    }

    // The target and our request to them, alongside any request they sent us
    const [relationship, [incomingRow], blockState] = await Promise.all([
      loadViewerRelationship(targetId, requesterId),
      db
        .select({ requestId: followRequests.id, requestedAt: followRequests.createdAt })
        .from(followRequests)
        .where(
          and(
            eq(followRequests.senderId, targetId),
            eq(followRequests.receiverId, requesterId),
            eq(followRequests.status, 'pending'),
          ),
        )
        .limit(1),
      blockStateBetween(requesterId, targetId),
    ]);

    if (!relationship) throw userNotFound();
    const { target, followStatus, isAcceptedFollower } = relationship;

    // The limited profile. A block clears follow requests both ways, so there
    // is no follow status or incoming request left to report.
    if (blockState.blockedByMe || blockState.blockedMe) {
      return {
        id: target.id,
        name: target.name,
        username: target.username,
        photoUrl: target.photoUrl ?? null,
        yearJoined: new Date(target.createdAt).getFullYear(),
        joinedAt: new Date(target.createdAt),
        followStatus: blockState.blockedByMe ? 'blocked' : 'none',
        incomingFollowRequest: null,
        shelfVisibility: target.shelfVisibility,
        canViewShelf: false,
        isBlocked: blockState.blockedByMe,
        hasBlockedYou: blockState.blockedMe,
      };
    }

    const base: UserProfile = {
      id: target.id,
      name: target.name,
      username: target.username,
      photoUrl: target.photoUrl ?? null,
      yearJoined: new Date(target.createdAt).getFullYear(),
      joinedAt: new Date(target.createdAt),
      followStatus,
      incomingFollowRequest: incomingRow ?? null,
      shelfVisibility: target.shelfVisibility,
      // Never self: this endpoint 400s on your own profile above
      canViewShelf: canViewShelf(target.shelfVisibility, false, isAcceptedFollower),
      isBlocked: false,
      hasBlockedYou: false,
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
   * Lists pending follow requests for the authenticated user. `direction`
   * picks the side: `incoming` (default) is people who have asked to follow
   * them — the ones they can accept or decline; `outgoing` is requests they
   * have sent that are still awaiting the other person's decision. Newest
   * first, and paginated since a spammed account could otherwise accumulate
   * an unbounded number of pending requests.
   */
  async listPendingFollowRequests(
    userId: number,
    limit: number,
    offset: number,
    direction: FollowRequestDirection = 'incoming',
  ): Promise<{ items: PendingFollowRequest[]; total: number }> {
    const incoming = direction === 'incoming';
    // The caller sits on one side of the row; the user we want to show is the other.
    const mineColumn  = incoming ? followRequests.receiverId : followRequests.senderId;
    const theirColumn = incoming ? followRequests.senderId   : followRequests.receiverId;
    const where = and(eq(mineColumn, userId), eq(followRequests.status, 'pending'));

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: followRequests.id,
          userId: users.id,
          name: users.name,
          username: users.username,
          photoUrl: users.photoUrl,
        })
        .from(followRequests)
        .innerJoin(users, eq(users.id, theirColumn))
        .where(where)
        .orderBy(desc(followRequests.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(followRequests)
        .where(where),
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
        .select({ id: users.id, name: users.name, username: users.username, photoUrl: users.photoUrl })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.senderId))
        .where(and(eq(followRequests.receiverId, targetId), eq(followRequests.status, 'accepted'), isNull(users.blacklistedAt)))
        .orderBy(desc(followRequests.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.senderId))
        .where(and(eq(followRequests.receiverId, targetId), eq(followRequests.status, 'accepted'), isNull(users.blacklistedAt))),
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
        .select({ id: users.id, name: users.name, username: users.username, photoUrl: users.photoUrl })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.receiverId))
        .where(and(eq(followRequests.senderId, targetId), eq(followRequests.status, 'accepted'), isNull(users.blacklistedAt)))
        .orderBy(desc(followRequests.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(followRequests)
        .innerJoin(users, eq(users.id, followRequests.receiverId))
        .where(and(eq(followRequests.senderId, targetId), eq(followRequests.status, 'accepted'), isNull(users.blacklistedAt))),
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
        .select({ name: users.name, photoUrl: users.photoUrl, emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, senderId))
        .limit(1),
      db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        // A blacklisted account cannot be followed: to everyone else it does not exist.
        .where(and(eq(users.id, receiverId), isNull(users.blacklistedAt)))
        .limit(1),
    ]);

    assertFound(sender, 'Sender');
    assertFound(target, 'Target user');

    if (!sender.emailVerified) {
      throw Object.assign(new Error('Please verify your email before sending follow requests'), { statusCode: 403 });
    }

    const blockState = await blockStateBetween(senderId, receiverId);
    if (blockState.blockedByMe) throw blockedError('Unblock this user to follow them');
    if (blockState.blockedMe) throw blockedError('You can’t follow this user');

    // The caller's own request to the target; one coming the other way doesn't matter
    const [outgoing] = await db
      .select({ id: followRequests.id, status: followRequests.status })
      .from(followRequests)
      .where(and(eq(followRequests.senderId, senderId), eq(followRequests.receiverId, receiverId)))
      .limit(1);

    const decision = decideFollowRequest(outgoing);

    // Every rejection is about a request that already exists, so it's a conflict
    if (decision.action === 'reject') {
      throw Object.assign(new Error(decision.message), { statusCode: 409 });
    }

    await db.transaction(async (tx) => {
      let requestId: number;

      if (decision.action === 'resend') {
        // Guarded on the status the decision was made from: if the request was
        // withdrawn or answered in the meantime, there is nothing to re-send —
        // and no row for the notification to point at.
        const [resent] = await tx
          .update(followRequests)
          .set({ status: 'pending', updatedAt: new Date() })
          .where(and(eq(followRequests.id, decision.requestId), eq(followRequests.status, 'declined')))
          .returning({ id: followRequests.id });

        if (!resent) {
          throw Object.assign(new Error('This follow request just changed. Please try again.'), { statusCode: 409 });
        }
        requestId = resent.id;
      } else {
        // onConflictDoNothing handles the concurrent-insert race; the first request wins
        const [inserted] = await tx
          .insert(followRequests)
          .values({ senderId, receiverId })
          .onConflictDoNothing()
          .returning({ id: followRequests.id });

        if (!inserted) {
          // Another concurrent request already created this follow request
          throw Object.assign(new Error('Follow request already sent'), { statusCode: 409 });
        }
        requestId = inserted.id;
      }

      await upsertFriendRequestNotification(tx, {
        id: requestId,
        receiverId,
        senderId,
        senderName: sender.name,
        senderPhotoUrl: sender.photoUrl ?? null,
      });
    });

    notificationPreferencesService.isEnabled(receiverId, 'friendRequests').then((enabled) => {
      if (!enabled) return;
      enqueueEmail('follow-request', {
        to: target.email,
        receiverName: target.name,
        senderName: sender.name,
      }).catch((err) => logger.error('Failed to enqueue follow-request email', { err }));
      enqueuePush('friend-request-sent', {
        userId: receiverId,
        senderId,
        senderName: sender.name,
      }).catch((err) => logger.error('Failed to enqueue follow-request push', { err }));
    }).catch((err) => logger.error('Failed to check follow-request notification preference', { err }));
  },

  async withdrawFollowRequest(senderId: number, receiverId: number): Promise<void> {
    const result = await db
      .delete(followRequests)
      .where(
        and(
          eq(followRequests.senderId, senderId),
          eq(followRequests.receiverId, receiverId),
        ),
      )
      .returning({ id: followRequests.id });

    if (result.length === 0) {
      throw Object.assign(new Error('No follow relationship found'), { statusCode: 404 });
    }
  },

  async acceptFollowRequest(requestId: number, receiverId: number): Promise<void> {
    // The pending check lives in the UPDATE itself so two concurrent accepts
    // (or an accept racing a decline) can't both succeed.
    const existing = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(followRequests)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(
          and(
            eq(followRequests.id, requestId),
            eq(followRequests.receiverId, receiverId),
            eq(followRequests.status, 'pending'),
          ),
        )
        .returning({ senderId: followRequests.senderId });

      if (!updated) {
        throw Object.assign(new Error('Follow request not found'), { statusCode: 404 });
      }

      await setFriendRequestNotificationStatus(tx, requestId, 'accepted');
      return updated;
    });

    const [[sender], [receiver]] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, existing.senderId)).limit(1),
      db.select({ name: users.name, photoUrl: users.photoUrl }).from(users).where(eq(users.id, receiverId)).limit(1),
    ]);

    if (sender && receiver) {
      notificationPreferencesService.isEnabled(existing.senderId, 'friendRequests').then((enabled) => {
        if (!enabled) return;
        enqueueEmail('follow-accepted', {
          to: sender.email,
          senderName: sender.name,
          accepterName: receiver.name,
        }).catch((err) => logger.error('Failed to enqueue follow-accepted email', { err }));
        enqueuePush('friend-request-accepted', {
          userId: existing.senderId,
          accepterId: receiverId,
          accepterName: receiver.name,
        }).catch((err) => logger.error('Failed to enqueue follow-accepted push', { err }));
        db.insert(notifications).values({
          userId: existing.senderId,
          type: 'follow_accepted',
          data: {
            followRequestId: requestId,
            accepterId: receiverId,
            accepterName: receiver.name,
            accepterPhotoUrl: receiver.photoUrl ?? null,
          },
        }).catch((err) => logger.error('Failed to store follow-accepted notification', { err }));
      }).catch((err) => logger.error('Failed to check follow-accepted notification preference', { err }));
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
    await db.transaction(async (tx) => {
      const result = await tx
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

      await setFriendRequestNotificationStatus(tx, requestId, 'declined');
    });
  },

  async getUserBooks(
    targetId: number,
    requesterId: number,
    filter: ShelfFilter,
    sort: ShelfSort,
    limit: number,
    offset: number,
  ): Promise<{ items: ShelfItem[]; total: number }> {
    await assertCanViewShelf(targetId, requesterId);

    const conditions = [eq(userBooks.userId, targetId)];
    if (filter === 'liked') {
      conditions.push(eq(userBooks.liked, true));
    } else if (filter === 'owned') {
      conditions.push(eq(userBooks.owned, true));
    } else if (filter !== 'all') {
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
          liked: userBooks.liked,
          owned: userBooks.owned,
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
