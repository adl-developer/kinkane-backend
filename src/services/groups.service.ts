import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  groups,
  groupMemberships,
  users,
  type Group,
  type GroupPrivacy,
  type GroupMembershipStatus,
} from '../db/schema';

// ── Types ─────────────────────────────────────────────────────────────────────

/** What the viewer is to this group. `none` covers both "never involved" and "declined". */
export type ViewerMembership = 'owner' | 'member' | 'invited' | 'none';

/**
 * Everything the client needs to pick which of the four group-detail layouts to
 * draw. Returning this rather than the raw privacy flag keeps the visibility
 * rules in one place — the app renders what the server decided instead of
 * re-deriving "can a non-member of a private group see the member list".
 */
export interface ViewerCapabilities {
  membership: ViewerMembership;
  canSeeMembers: boolean;
  canInvite: boolean;
  canEdit: boolean;
  canJoin: boolean;
}

export interface GroupSummary {
  id: number;
  name: string;
  description: string | null;
  photoUrl: string | null;
  privacy: GroupPrivacy;
  memberCount: number;
  createdAt: Date;
}

export interface GroupDetail extends GroupSummary {
  owner: { id: number; name: string; photoUrl: string | null };
}

export interface CreateGroupInput {
  name: string;
  description?: string | null;
  photoUrl?: string | null;
  privacy?: GroupPrivacy;
}

export type UpdateGroupInput = Partial<CreateGroupInput>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function notFound(): Error {
  return Object.assign(new Error('Group not found'), { statusCode: 404 });
}

/**
 * Decides what a viewer may see and do, from the group and their membership row.
 *
 * Pure and exported so the visibility rules can be pinned by unit test without
 * a database — they are the security boundary of the whole feature, and the
 * combinations (4 memberships x 2 privacies) are more than a reviewer can hold
 * in their head while reading a query.
 */
export function groupViewerCapabilities(
  group: { ownerId: number; privacy: GroupPrivacy },
  membershipStatus: GroupMembershipStatus | null,
  viewerId: number,
): ViewerCapabilities {
  const isOwner = group.ownerId === viewerId;
  // The owner holds an 'active' membership row too, but treat them as owner
  // even if that row is somehow missing — ownership is the source of truth.
  const membership: ViewerMembership = isOwner
    ? 'owner'
    : membershipStatus === 'active'
      ? 'member'
      : membershipStatus === 'invited'
        ? 'invited'
        : 'none';

  const isMember = membership === 'owner' || membership === 'member';

  return {
    membership,
    // A private group's member list is the part that is actually private.
    canSeeMembers: isMember || group.privacy === 'public',
    // Any member can invite, not just the owner — the design puts
    // "+ Invite friends" on the plain-member view, and a private group would
    // otherwise depend entirely on its owner to grow.
    canInvite: isMember,
    canEdit: isOwner,
    canJoin: !isMember && membership !== 'invited' && group.privacy === 'public',
  };
}

function toSummary(row: Group): GroupSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    photoUrl: row.photoUrl,
    privacy: row.privacy,
    memberCount: row.memberCount,
    createdAt: row.createdAt,
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export const groupsService = {
  /**
   * Creates a group and makes the creator its first member, in one transaction.
   *
   * The owner's membership row is what keeps member_count honest: the count
   * starts at 1, the owner appears in the member list, and "34 users joined"
   * means the same thing on every surface.
   */
  async create(ownerId: number, input: CreateGroupInput): Promise<GroupSummary> {
    return db.transaction(async (tx) => {
      const [group] = await tx
        .insert(groups)
        .values({
          ownerId,
          name: input.name,
          description: input.description ?? null,
          photoUrl: input.photoUrl ?? null,
          privacy: input.privacy ?? 'public',
          memberCount: 1,
        })
        .returning();

      await tx.insert(groupMemberships).values({
        groupId: group.id,
        userId: ownerId,
        status: 'active',
        joinedAt: new Date(),
      });

      return toSummary(group);
    });
  },

  /**
   * One group plus what this viewer may do with it.
   *
   * Private groups are returned to non-members on purpose — see the note on
   * groupPrivacyEnum. The capability block, not the 404, is what withholds
   * anything.
   */
  async get(groupId: number, viewerId: number): Promise<{ group: GroupDetail; viewer: ViewerCapabilities }> {
    const [row] = await db
      .select({
        group: groups,
        ownerName: users.name,
        ownerPhotoUrl: users.photoUrl,
      })
      .from(groups)
      .innerJoin(users, eq(users.id, groups.ownerId))
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!row) throw notFound();

    const [membership] = await db
      .select({ status: groupMemberships.status })
      .from(groupMemberships)
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, viewerId)))
      .limit(1);

    return {
      group: {
        ...toSummary(row.group),
        owner: { id: row.group.ownerId, name: row.ownerName, photoUrl: row.ownerPhotoUrl },
      },
      viewer: groupViewerCapabilities(row.group, membership?.status ?? null, viewerId),
    };
  },

  /** Groups the user belongs to — owned or joined. Powers "Your groups". */
  async listForUser(
    userId: number,
    limit: number,
    offset: number,
  ): Promise<{ groups: GroupSummary[]; total: number }> {
    const membershipFilter = and(
      eq(groupMemberships.userId, userId),
      eq(groupMemberships.status, 'active'),
    );

    const [rows, [counted]] = await Promise.all([
      db
        .select({ group: groups })
        .from(groupMemberships)
        .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
        .where(membershipFilter)
        .orderBy(desc(groupMemberships.joinedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(groupMemberships)
        .where(membershipFilter),
    ]);

    return { groups: rows.map((r) => toSummary(r.group)), total: counted?.count ?? 0 };
  },

  /** Discovery list, newest first. Private groups are included — they are unjoinable, not secret. */
  async list(limit: number, offset: number): Promise<{ groups: GroupSummary[]; total: number }> {
    const [rows, [counted]] = await Promise.all([
      db.select().from(groups).orderBy(desc(groups.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(groups),
    ]);

    return { groups: rows.map(toSummary), total: counted?.count ?? 0 };
  },

  /**
   * Owner-only edit. Serves both the Edit Group screen and the standalone
   * Privacy Settings screen — the latter just sends `privacy` on its own.
   *
   * Ownership is folded into the WHERE clause, so a non-owner gets the same
   * 404 as a missing group rather than a 403 confirming it exists and is
   * someone else's. Same shape as communityService.deletePost.
   */
  async update(groupId: number, ownerId: number, input: UpdateGroupInput): Promise<GroupSummary> {
    const [updated] = await db
      .update(groups)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.photoUrl !== undefined && { photoUrl: input.photoUrl }),
        ...(input.privacy !== undefined && { privacy: input.privacy }),
        updatedAt: new Date(),
      })
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
      .returning();

    if (!updated) throw notFound();
    return toSummary(updated);
  },

  /**
   * Owner-only delete. Memberships cascade.
   *
   * The caller must have re-proved who they are (password or fresh id token)
   * before this is reached — that check lives in the controller, ahead of any
   * write, so a wrong credential never touches the group.
   */
  async remove(groupId: number, ownerId: number): Promise<void> {
    const deleted = await db
      .delete(groups)
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
      .returning({ id: groups.id });

    if (deleted.length === 0) throw notFound();
  },
};
