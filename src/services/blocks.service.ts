import { and, desc, eq, inArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db';
import { userBlocks, users, followRequests, notifications, groupMemberships } from '../db/schema';
import type { HttpError } from '../lib/route-helpers';

/**
 * Blocking, and the one rule every other service asks about it.
 *
 * A block is recorded one way (the blocker is the only one who can lift it) but
 * works both ways: neither person sees the other in the community feed or in
 * search, neither can tag the other, and neither can engage with the other's
 * posts or comments. The blocked person can still open the blocker's profile,
 * but only the limited version — name, photo and join date, nothing else.
 *
 * In a book club the two share, each still sees what the other writes — the
 * conversation would not make sense with holes in it — but cannot reply to it,
 * like it, or open the other's profile from it.
 *
 * So the question the rest of the code asks is always the symmetric one —
 * "is there a block between these two, either way?" — and only the profile and
 * the blocked list care which way it points.
 */

// ── The rule ─────────────────────────────────────────────────────────────────

/**
 * True when `viewerId` and the user in `other` (a column, usually users.id or
 * a table's user_id) have blocked each other in either direction. Both halves
 * are primary-key or index lookups.
 */
export function blockedBetween(viewerId: number, other: SQLWrapper): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${userBlocks}
    WHERE (${userBlocks.blockerId} = ${viewerId} AND ${userBlocks.blockedId} = ${other})
       OR (${userBlocks.blockerId} = ${other} AND ${userBlocks.blockedId} = ${viewerId})
  )`;
}

/** The filter for anything a blocked pair should not see of each other. */
export function notBlockedBetween(viewerId: number, other: SQLWrapper): SQL {
  return sql`NOT ${blockedBetween(viewerId, other)}`;
}

export interface BlockState {
  /** The viewer has blocked them. */
  blockedByMe: boolean;
  /** They have blocked the viewer. */
  blockedMe: boolean;
}

/** Which way, if any, a block runs between two people. */
export async function blockStateBetween(viewerId: number, otherId: number): Promise<BlockState> {
  if (viewerId === otherId) return { blockedByMe: false, blockedMe: false };
  const rows = await db
    .select({ blockerId: userBlocks.blockerId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, viewerId), eq(userBlocks.blockedId, otherId)),
        and(eq(userBlocks.blockerId, otherId), eq(userBlocks.blockedId, viewerId)),
      ),
    );
  return {
    blockedByMe: rows.some((r) => r.blockerId === viewerId),
    blockedMe: rows.some((r) => r.blockerId === otherId),
  };
}

export async function isBlockedBetween(viewerId: number, otherId: number): Promise<boolean> {
  const state = await blockStateBetween(viewerId, otherId);
  return state.blockedByMe || state.blockedMe;
}

/** Of `ids`, the people with a block between them and the viewer, either way. */
export async function blockedAmong(viewerId: number, ids: number[]): Promise<Set<number>> {
  const others = [...new Set(ids)].filter((id) => id !== viewerId);
  if (others.length === 0) return new Set();
  const rows = await db
    .select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.blockerId, viewerId), inArray(userBlocks.blockedId, others)),
        and(eq(userBlocks.blockedId, viewerId), inArray(userBlocks.blockerId, others)),
      ),
    );
  return new Set(rows.map((r) => (r.blockerId === viewerId ? r.blockedId : r.blockerId)));
}

/**
 * The refusal for engaging with someone across a block. A 403 with a stable
 * code, so the app can say why rather than show a generic error — the person
 * hitting it is one of the two, and already knows there is a block.
 */
export function blockedError(message = 'You can’t interact with this user'): HttpError {
  return Object.assign(new Error(message), { statusCode: 403, code: 'BLOCKED' });
}

export async function assertNotBlocked(viewerId: number, otherId: number, message?: string): Promise<void> {
  if (await isBlockedBetween(viewerId, otherId)) throw blockedError(message);
}

// ── Blocking itself ──────────────────────────────────────────────────────────

/**
 * The keys our notification rows name their actor by, one per producer. A
 * block clears what each of the two has been sent about the other, so that an
 * old "liked your post" does not lead straight to someone you have blocked.
 * friend_request rows need no entry: they go with their follow request.
 */
const NOTIFICATION_ACTOR_KEYS = ['likerId', 'commenterId', 'inviterId', 'accepterId', 'mentionerId', 'senderId'];

function notificationsAbout(recipientId: number, actorId: number): SQL {
  const actorMatches = NOTIFICATION_ACTOR_KEYS.map(
    (key) => sql`(${notifications.data} ->> ${key}) = ${String(actorId)}`,
  );
  return and(eq(notifications.userId, recipientId), or(...actorMatches))!;
}

export interface BlockedUserItem {
  id: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
  reason: string | null;
  blockedAt: Date;
}

export const blocksService = {
  /**
   * Blocks `blockedId`. Safe to repeat: blocking someone already blocked keeps
   * the original block and its reason.
   *
   * In the same transaction, everything between the two that a block makes
   * meaningless is cleared: follows and follow requests in both directions,
   * the notifications each has had about the other, and any pending book-club
   * invitation one has sent the other. Their posts, comments and likes are
   * left alone — they are hidden from each other on read, and come back if the
   * block is lifted.
   */
  async block(blockerId: number, blockedId: number, reason: string | null): Promise<BlockedUserItem> {
    if (blockerId === blockedId) {
      throw Object.assign(new Error('You can’t block yourself'), { statusCode: 400 });
    }

    const [target] = await db
      .select({ id: users.id, name: users.name, username: users.username, photoUrl: users.photoUrl })
      .from(users)
      .where(eq(users.id, blockedId))
      .limit(1);
    if (!target) throw Object.assign(new Error('User not found'), { statusCode: 404 });

    const block = await db.transaction(async (tx) => {
      await tx.insert(userBlocks).values({ blockerId, blockedId, reason }).onConflictDoNothing();

      // Deleting the follow request also takes its friend_request notification
      // (FK cascade).
      await tx
        .delete(followRequests)
        .where(
          or(
            and(eq(followRequests.senderId, blockerId), eq(followRequests.receiverId, blockedId)),
            and(eq(followRequests.senderId, blockedId), eq(followRequests.receiverId, blockerId)),
          ),
        );

      await tx
        .delete(notifications)
        .where(or(notificationsAbout(blockerId, blockedId), notificationsAbout(blockedId, blockerId)));

      // Only invitations still waiting: someone who already joined stays in
      // the club, where the shared-group rules apply.
      await tx
        .delete(groupMemberships)
        .where(
          and(
            eq(groupMemberships.status, 'invited'),
            or(
              and(eq(groupMemberships.userId, blockedId), eq(groupMemberships.invitedBy, blockerId)),
              and(eq(groupMemberships.userId, blockerId), eq(groupMemberships.invitedBy, blockedId)),
            ),
          ),
        );

      const [row] = await tx
        .select({ reason: userBlocks.reason, createdAt: userBlocks.createdAt })
        .from(userBlocks)
        .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))
        .limit(1);
      return row;
    });

    return { ...target, reason: block.reason, blockedAt: block.createdAt };
  },

  /**
   * Lifts the caller's block. Nothing cleared by the block comes back — the
   * two have to follow each other again — but everything hidden on read
   * reappears. A block the other person placed is theirs and stays.
   */
  async unblock(blockerId: number, blockedId: number): Promise<void> {
    const removed = await db
      .delete(userBlocks)
      .where(and(eq(userBlocks.blockerId, blockerId), eq(userBlocks.blockedId, blockedId)))
      .returning({ blockedId: userBlocks.blockedId });
    if (removed.length === 0) {
      throw Object.assign(new Error('You haven’t blocked this user'), { statusCode: 404 });
    }
  },

  /** The people the caller has blocked, most recent first — for Settings → Blocked users. */
  async list(blockerId: number, limit: number, offset: number): Promise<{ items: BlockedUserItem[]; total: number }> {
    const where = eq(userBlocks.blockerId, blockerId);
    const [items, [counted]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          username: users.username,
          photoUrl: users.photoUrl,
          reason: userBlocks.reason,
          blockedAt: userBlocks.createdAt,
        })
        .from(userBlocks)
        .innerJoin(users, eq(users.id, userBlocks.blockedId))
        .where(where)
        .orderBy(desc(userBlocks.createdAt), desc(userBlocks.blockedId))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(userBlocks).where(where),
    ]);
    return { items, total: counted?.count ?? 0 };
  },
};
