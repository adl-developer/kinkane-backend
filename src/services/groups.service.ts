import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
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

export interface GroupMember {
  id: number;
  name: string;
  photoUrl: string | null;
  isOwner: boolean;
  joinedAt: Date | null;
}

/** A membership action a viewer can attempt against a group. */
export type MembershipAction = 'view_members' | 'join' | 'leave';

/** The viewer's standing, as the decision function needs it. */
export interface ViewerStanding {
  privacy: GroupPrivacy;
  isOwner: boolean;
  status: GroupMembershipStatus | null;
}

/** Allowed, or the status code and message to fail with. */
export type MembershipDecision =
  | { allowed: true }
  | { allowed: false; statusCode: number; message: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function notFound(): Error {
  return Object.assign(new Error('Group not found'), { statusCode: 404 });
}

const ALLOW: MembershipDecision = { allowed: true };
const deny = (statusCode: number, message: string): MembershipDecision => ({
  allowed: false,
  statusCode,
  message,
});

/**
 * The membership rules, in one pure function.
 *
 * Every one of these is a rule someone will otherwise re-derive slightly
 * differently in a controller, so they live here and are pinned by unit test.
 *
 * On the choice of status codes: a membership-gated read against a group the
 * viewer can already see is a 403, not a 404, because a private group's
 * existence is not secret — the design deliberately shows non-members its name,
 * owner and description. Only owner-scoped *mutations* 404, and those never
 * reach this function: ownership is folded into their WHERE clause instead.
 */
export function decideMembershipAction(
  action: MembershipAction,
  { privacy, isOwner, status }: ViewerStanding,
): MembershipDecision {
  const isMember = isOwner || status === 'active';

  switch (action) {
    case 'view_members':
      // The member list is the part of a private group that is actually private.
      // An invitee to a public group is at least as entitled as a passer-by, so
      // this turns on membership and privacy only — never on the invite.
      return isMember || privacy === 'public'
        ? ALLOW
        : deny(403, 'Only members can see who is in a private group');

    case 'join':
      // Ordered so the most specific answer wins: telling an existing member
      // that the group is private would be nonsense.
      if (isMember) return deny(409, 'You are already a member of this group');
      if (status === 'invited') {
        return deny(409, 'You have been invited to this group — accept the invitation instead');
      }
      if (privacy === 'private') {
        return deny(403, 'This group is private — you need an invitation to join');
      }
      return ALLOW;

    case 'leave':
      // The owner leaving would orphan the group, and nothing in the design
      // offers to hand it over, so this is a dead end by choice rather than an
      // oversight. 400 rather than 403: it is not a permission problem.
      if (isOwner) {
        return deny(400, 'The group owner cannot leave — delete the group instead');
      }
      if (status !== 'active') return deny(404, 'You are not a member of this group');
      return ALLOW;
  }
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

/**
 * Matches a group by name or description, in four widening tiers.
 *
 * Deliberately the same shape as `buildUserSearchCondition` in
 * community-search.service.ts, down to the 0.3 threshold and the three-character
 * floor on full text: when the Community "Groups" tab and the Explore
 * Books|Authors|Groups toggle are wired up, groups have to rank the way users
 * and posts already do, or the same query gives noticeably different results
 * depending on which tab you are looking at.
 *
 * Tiers, in order: exact prefix, word prefix, trigram similarity, full text.
 * `word_similarity` is backed by the gin_trgm_ops index on `name`, and the full
 * text arm by the GIN index on the generated `search_vector` — without those two
 * this degrades to a sequential scan over every group.
 *
 * Full text is skipped below three characters because `plainto_tsquery` on one
 * or two letters matches almost nothing useful while still costing an index
 * probe; the prefix tiers are what make short queries feel instant.
 *
 * Exported so the compiled SQL can be asserted on without a database, the way
 * author-search.test.ts does.
 */
export function buildGroupSearchCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  const fts = q.length >= 3
    ? sql` OR ${groups.searchVector} @@ plainto_tsquery('simple', ${q})`
    : sql``;

  return sql`(
    ${groups.name} ILIKE ${prefix}
    OR ${groups.name} ILIKE ${wordPrefix}
    OR word_similarity(${q}, ${groups.name}) > 0.3
    ${fts}
  )`;
}

/**
 * Ranks the matches from `buildGroupSearchCondition`.
 *
 * The CASE must keep one branch per tier in that condition, in the same order —
 * if the two drift apart, rows still match but come back in an order that looks
 * arbitrary, which is far harder to notice than a missing result.
 */
export function buildGroupSearchOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  return [
    sql`CASE
      WHEN ${groups.name} ILIKE ${prefix}     THEN 0
      WHEN ${groups.name} ILIKE ${wordPrefix} THEN 1
      WHEN word_similarity(${q}, ${groups.name}) > 0.3 THEN 2
      ELSE 3
    END`,
    sql`word_similarity(${q}, ${groups.name}) DESC`,
    sql`ts_rank(${groups.searchVector}, plainto_tsquery('simple', ${q})) DESC`,
  ];
}

/**
 * Loads the group's privacy and owner plus the viewer's membership row, in one
 * round trip, for the membership endpoints to decide on.
 *
 * 404s a missing group here so the three callers do not each repeat it, and so
 * "no such group" is answered before any membership rule runs — otherwise a
 * join against a deleted group would report it as private.
 */
async function loadStanding(
  groupId: number,
  viewerId: number,
): Promise<ViewerStanding & { ownerId: number }> {
  const [row] = await db
    .select({
      ownerId: groups.ownerId,
      privacy: groups.privacy,
      status: groupMemberships.status,
    })
    .from(groups)
    .leftJoin(
      groupMemberships,
      and(eq(groupMemberships.groupId, groups.id), eq(groupMemberships.userId, viewerId)),
    )
    .where(eq(groups.id, groupId))
    .limit(1);

  if (!row) throw notFound();

  return {
    ownerId: row.ownerId,
    privacy: row.privacy,
    isOwner: row.ownerId === viewerId,
    status: row.status ?? null,
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

  /**
   * Discovery list. Newest first when browsing, best match first when searching.
   *
   * Private groups are included either way — they are unjoinable, not secret,
   * and hiding them here would make the "you need an invite" screen unreachable
   * for anyone who had not already been sent a link.
   *
   * `total` is the count of everything matching the same condition, not the page,
   * so the client can paginate against it.
   */
  async list(
    limit: number,
    offset: number,
    q?: string,
  ): Promise<{ groups: GroupSummary[]; total: number }> {
    // A query of only whitespace is a browse, not a search — matching every
    // group against '%' would rank arbitrarily and read as broken.
    const term = q?.trim();
    const where = term ? buildGroupSearchCondition(term) : undefined;
    const orderBy = term ? buildGroupSearchOrderBy(term) : [desc(groups.createdAt)];

    const [rows, [counted]] = await Promise.all([
      db.select().from(groups).where(where).orderBy(...orderBy).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(groups).where(where),
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
   * The people in a group, oldest first — so the owner, who joins at creation,
   * heads the list.
   *
   * `total` comes from counting memberships rather than reading
   * `groups.member_count`: this is the one place the two can be compared, and a
   * list that disagreed with its own total would be the first visible symptom
   * of counter drift.
   */
  async listMembers(
    groupId: number,
    viewerId: number,
    limit: number,
    offset: number,
  ): Promise<{ members: GroupMember[]; total: number }> {
    const standing = await loadStanding(groupId, viewerId);
    const decision = decideMembershipAction('view_members', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    const activeMembers = and(
      eq(groupMemberships.groupId, groupId),
      eq(groupMemberships.status, 'active'),
    );

    const [rows, [counted]] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          photoUrl: users.photoUrl,
          joinedAt: groupMemberships.joinedAt,
        })
        .from(groupMemberships)
        .innerJoin(users, eq(users.id, groupMemberships.userId))
        .where(activeMembers)
        .orderBy(groupMemberships.joinedAt)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(groupMemberships).where(activeMembers),
    ]);

    return {
      members: rows.map((r) => ({ ...r, isOwner: r.id === standing.ownerId })),
      total: counted?.count ?? 0,
    };
  },

  /**
   * Joins a public group.
   *
   * The insert and the counter move together in one transaction, and the unique
   * (group, user) index is what makes a double tap safe: the second insert
   * conflicts, returns nothing, and never reaches the increment. Without that,
   * two taps would leave one membership and a count of two.
   */
  async join(groupId: number, userId: number): Promise<{ memberCount: number }> {
    const standing = await loadStanding(groupId, userId);
    const decision = decideMembershipAction('join', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(groupMemberships)
        .values({ groupId, userId, status: 'active', joinedAt: new Date() })
        .onConflictDoNothing()
        .returning({ id: groupMemberships.id });

      if (inserted.length === 0) {
        // Lost the race with another tap — the membership exists either way, so
        // this is the same answer the guard above would have given.
        throw Object.assign(new Error('You are already a member of this group'), {
          statusCode: 409,
        });
      }

      const [updated] = await tx
        .update(groups)
        .set({ memberCount: sql`${groups.memberCount} + 1` })
        .where(eq(groups.id, groupId))
        .returning({ memberCount: groups.memberCount });

      return { memberCount: updated?.memberCount ?? 0 };
    });
  },

  /** Leaves a group. The owner cannot; they delete it instead. */
  async leave(groupId: number, userId: number): Promise<void> {
    const standing = await loadStanding(groupId, userId);
    const decision = decideMembershipAction('leave', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(groupMemberships)
        .where(
          and(
            eq(groupMemberships.groupId, groupId),
            eq(groupMemberships.userId, userId),
            eq(groupMemberships.status, 'active'),
          ),
        )
        .returning({ id: groupMemberships.id });

      if (deleted.length === 0) {
        throw Object.assign(new Error('You are not a member of this group'), { statusCode: 404 });
      }

      // GREATEST rather than a bare decrement: if the counter has drifted to 0
      // while a membership still exists, a plain `- 1` would violate the
      // non-negative CHECK and trap the member in a group they are trying to
      // leave. Drift is a data problem to repair, not a reason to refuse.
      await tx
        .update(groups)
        .set({ memberCount: sql`GREATEST(${groups.memberCount} - 1, 0)` })
        .where(eq(groups.id, groupId));
    });
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
