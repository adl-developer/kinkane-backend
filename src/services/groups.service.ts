import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  groups,
  groupMemberships,
  users,
  followRequests,
  notifications,
  notificationPreferences,
  type Group,
  type GroupPrivacy,
  type GroupMembershipStatus,
} from '../db/schema';
import { enqueuePush } from '../lib/push-queue';
import { logger } from '../lib/logger';

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
export type MembershipAction =
  | 'view_members'
  | 'join'
  | 'leave'
  | 'invite'
  | 'accept_invite'
  | 'decline_invite';

/** Why a requested invitee was not invited. Reported per user rather than failing the batch. */
export type InviteSkipReason = 'self' | 'already_member' | 'already_invited' | 'not_a_friend';

export interface InviteResult {
  invited: number[];
  skipped: { userId: number; reason: InviteSkipReason }[];
}

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

    case 'invite':
      // Any member can invite, not only the owner: the design puts
      // "+ Invite friends" on the plain-member view, and a private group would
      // otherwise depend entirely on its owner to grow. An invitee cannot
      // invite onward until they have accepted.
      return isMember ? ALLOW : deny(403, 'Only members can invite people to this group');

    case 'accept_invite':
    case 'decline_invite':
      // 404 rather than 403: with no invitation there is nothing to act on, and
      // the answer must not differ between "never invited" and "already
      // handled" — otherwise it reports whether an invitation once existed.
      return status === 'invited' ? ALLOW : deny(404, 'You have no invitation to this group');
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
 * Matches users who are friends of `viewerId` — an accepted follow in *either*
 * direction.
 *
 * Bidirectional on purpose: it matches the friend count shown on a profile, and
 * the narrower reading (only people the viewer follows) would hide someone who
 * followed them first, which is not how "Invite your friends" reads.
 *
 * Written as `id IN (union of two index scans)` rather than the more obvious
 * correlated `EXISTS (... sender = v AND receiver = u.id OR receiver = v AND
 * sender = u.id)`. Both are correct, but the OR spans two different columns, so
 * the planner cannot use it as a join *key* — it degrades to a join *filter*,
 * materialising the viewer's follow rows and re-testing them against every
 * candidate user (visible in EXPLAIN as "Rows Removed by Join Filter"). Split
 * into a union, each branch is a plain indexed lookup and the result is an
 * equijoin on users.id, so the work is bounded by how many friends the viewer
 * has rather than by how many accounts exist.
 *
 * Exported so the compiled SQL can be asserted on without a database.
 */
export function friendOfCondition(viewerId: number): SQL {
  return sql`${users.id} IN (
    SELECT ${followRequests.receiverId} FROM ${followRequests}
      WHERE ${followRequests.senderId} = ${viewerId} AND ${followRequests.status} = 'accepted'
    UNION
    SELECT ${followRequests.senderId} FROM ${followRequests}
      WHERE ${followRequests.receiverId} = ${viewerId} AND ${followRequests.status} = 'accepted'
  )`;
}

/**
 * Name matching for the friend picker's search box.
 *
 * Only the two prefix tiers, not the full four used for discovery: this searches
 * a list the viewer already knows, usually a few dozen names, where typing "th"
 * should narrow to people called Theo rather than fuzzily rank strangers.
 */
export function buildFriendNameCondition(q: string): SQL {
  return sql`(${users.name} ILIKE ${q + '%'} OR ${users.name} ILIKE ${'% ' + q + '%'})`;
}

/**
 * Notifies people who were just invited to a group: a stored in-app row and a
 * push, per invitee, gated on their own preference.
 *
 * Push and in-app only, never email — the same policy the post-like and
 * post-comment producers follow. An invitation is worth a badge, not an inbox.
 *
 * The stored row is a *record of an event*, not a live view of the invitation,
 * which is why it is an ordinary notification rather than the synthesized shape
 * friend requests use: accepting or declining later does not delete it, and the
 * current state is re-read from the group when the card is tapped.
 *
 * Details are denormalised into `data` at write time — the same reason
 * notifyPostLike stores `likerName` — so rendering the card needs no join, and
 * the card still reads correctly if the group is later renamed or deleted.
 */
async function notifyInvitees(
  groupId: number,
  inviterId: number,
  inviteeIds: number[],
): Promise<void> {
  const [[group], [inviter]] = await Promise.all([
    db
      .select({ name: groups.name, photoUrl: groups.photoUrl })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1),
    db
      .select({ name: users.name, photoUrl: users.photoUrl })
      .from(users)
      .where(eq(users.id, inviterId))
      .limit(1),
  ]);

  if (!group || !inviter) return;

  // One query for the whole batch. Previously this was a lookup per invitee —
  // up to 50 round trips, several of which would also lazily INSERT a defaults
  // row. Anyone with no row at all defaults to enabled, which is exactly what
  // the per-user helper does.
  const prefs = await db
    .select({ userId: notificationPreferences.userId, groupInvites: notificationPreferences.groupInvites })
    .from(notificationPreferences)
    .where(inArray(notificationPreferences.userId, inviteeIds));
  const disabled = new Set(prefs.filter((p) => !p.groupInvites).map((p) => p.userId));
  const recipients = inviteeIds.filter((id) => !disabled.has(id));
  if (recipients.length === 0) return;

  const data = {
    groupId,
    groupName: group.name,
    groupPhotoUrl: group.photoUrl,
    inviterId,
    inviterName: inviter.name,
    inviterPhotoUrl: inviter.photoUrl,
  };

  await Promise.all([
    db.insert(notifications).values(
      recipients.map((userId) => ({ userId, type: 'group_invite' as const, data })),
    ),
    ...recipients.map((userId) =>
      enqueuePush('group-invite', {
        userId,
        groupId,
        groupName: group.name,
        inviterName: inviter.name,
      }),
    ),
  ]);
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

/**
 * The columns a group summary needs, named explicitly.
 *
 * `select()` with no argument would also fetch `search_vector`, the GENERATED
 * tsvector, which nothing reads — measured at ~1.5 KB for a group with a
 * full-length description, so roughly 73 KB per 50-row page fetched and thrown
 * away. Listing the columns keeps it on the server.
 */
const groupSummaryColumns = {
  id: groups.id,
  ownerId: groups.ownerId,
  name: groups.name,
  description: groups.description,
  photoUrl: groups.photoUrl,
  privacy: groups.privacy,
  memberCount: groups.memberCount,
  createdAt: groups.createdAt,
} as const;

type GroupSummaryRow = {
  [K in keyof typeof groupSummaryColumns]: Group[K & keyof Group];
};

function toSummary(row: GroupSummaryRow): GroupSummary {
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
        .returning(groupSummaryColumns);

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
    // Group, owner and the viewer's membership in one round trip. This used to
    // be two sequential queries, which both cost an extra hop and meant the
    // question "what is this viewer to this group" was answered two different
    // ways in one file — here and in loadStanding. One shape, one place to
    // change when the membership rules move.
    const [row] = await db
      .select({
        ...groupSummaryColumns,
        ownerName: users.name,
        ownerPhotoUrl: users.photoUrl,
        viewerStatus: groupMemberships.status,
      })
      .from(groups)
      .innerJoin(users, eq(users.id, groups.ownerId))
      .leftJoin(
        groupMemberships,
        and(eq(groupMemberships.groupId, groups.id), eq(groupMemberships.userId, viewerId)),
      )
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!row) throw notFound();

    return {
      group: {
        ...toSummary(row),
        owner: { id: row.ownerId, name: row.ownerName, photoUrl: row.ownerPhotoUrl },
      },
      viewer: groupViewerCapabilities(row, row.viewerStatus ?? null, viewerId),
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
        .select(groupSummaryColumns)
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

    return { groups: rows.map(toSummary), total: counted?.count ?? 0 };
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
      db.select(groupSummaryColumns).from(groups).where(where).orderBy(...orderBy).limit(limit).offset(offset),
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
      .returning(groupSummaryColumns);

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

  /**
   * The caller's friends who could still be invited to this group.
   *
   * Excluding anyone with an existing membership row is what keeps the picker
   * honest — a checkbox next to someone who joined ten minutes ago is a
   * guaranteed "skipped" on submit.
   *
   * "Friend" means an accepted follow in *either* direction, matching the count
   * shown on a profile. The narrower reading (only people you follow) would hide
   * someone who followed you first, which is not how the screen reads.
   */
  async listInvitableFriends(
    groupId: number,
    viewerId: number,
    limit: number,
    offset: number,
    q?: string,
  ): Promise<{ friends: { id: number; name: string; photoUrl: string | null }[]; total: number }> {
    const standing = await loadStanding(groupId, viewerId);
    const decision = decideMembershipAction('invite', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    const term = q?.trim();
    const where = and(
      friendOfCondition(viewerId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${groupMemberships}
        WHERE ${groupMemberships.groupId} = ${groupId}
          AND ${groupMemberships.userId} = ${users.id}
      )`,
      term ? buildFriendNameCondition(term) : undefined,
    );

    const [rows, [counted]] = await Promise.all([
      db
        .select({ id: users.id, name: users.name, photoUrl: users.photoUrl })
        .from(users)
        .where(where)
        .orderBy(users.name)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(users).where(where),
    ]);

    return { friends: rows, total: counted?.count ?? 0 };
  },

  /**
   * Invites friends to a group.
   *
   * Partial success by design: the picker can offer three people and one of them
   * may have joined in the meantime, so unusable ids come back in `skipped` with
   * a reason rather than failing the whole batch and losing the other two.
   *
   * The insert is a single statement with ON CONFLICT DO NOTHING, and the rows
   * it returns are the ones genuinely created — which is also the concurrency
   * answer: two people inviting the same friend at once produce one invitation,
   * and only one of them is told they created it.
   */
  async invite(groupId: number, inviterId: number, userIds: number[]): Promise<InviteResult> {
    const standing = await loadStanding(groupId, inviterId);
    const decision = decideMembershipAction('invite', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    const requested = [...new Set(userIds)];
    const skipped: InviteResult['skipped'] = [];

    const candidates = requested.filter((id) => {
      if (id === inviterId) {
        skipped.push({ userId: id, reason: 'self' });
        return false;
      }
      return true;
    });

    if (candidates.length === 0) return { invited: [], skipped };

    // Friendship is enforced here even though the picker only ever offers
    // friends: a non-friend id means a stale client or someone probing, and
    // neither should be able to push an invitation at a stranger.
    const friends = await db
      .select({ id: users.id })
      .from(users)
      .where(and(friendOfCondition(inviterId), inArray(users.id, candidates)));
    const friendIds = new Set(friends.map((f) => f.id));

    const invitable = candidates.filter((id) => {
      if (!friendIds.has(id)) {
        skipped.push({ userId: id, reason: 'not_a_friend' });
        return false;
      }
      return true;
    });

    if (invitable.length === 0) return { invited: [], skipped };

    const inserted = await db
      .insert(groupMemberships)
      .values(
        invitable.map((userId) => ({
          groupId,
          userId,
          status: 'invited' as const,
          invitedBy: inviterId,
        })),
      )
      .onConflictDoNothing()
      .returning({ userId: groupMemberships.userId });

    const invited = inserted.map((r) => r.userId);

    // Anything requested but not created already had a row. One follow-up read
    // turns that into a reason the client can show.
    const notCreated = invitable.filter((id) => !invited.includes(id));
    if (notCreated.length > 0) {
      const existing = await db
        .select({ userId: groupMemberships.userId, status: groupMemberships.status })
        .from(groupMemberships)
        .where(
          and(eq(groupMemberships.groupId, groupId), inArray(groupMemberships.userId, notCreated)),
        );
      const statusByUser = new Map(existing.map((e) => [e.userId, e.status]));
      for (const id of notCreated) {
        // Exhaustive over the status rather than "invited or else member".
        // 'requested' is reserved and unreachable today, but once
        // request-to-join exists, reporting such a person as an existing member
        // would both mislead the inviter and leave the picker hiding them.
        const status = statusByUser.get(id);
        const reason: InviteSkipReason =
          status === 'invited' || status === 'requested' ? 'already_invited' : 'already_member';
        skipped.push({ userId: id, reason });
      }
    }

    if (invited.length > 0) {
      // Fire and forget: an invitation is recorded the moment the row exists,
      // and a notification that fails to enqueue must not undo it or fail the
      // request. Only genuinely-created rows notify, so a re-invite of someone
      // already invited stays silent rather than nagging them again.
      notifyInvitees(groupId, inviterId, invited).catch((err: Error) =>
        logger.error('Failed to notify group invitees', {
          groupId,
          inviterId,
          error: err.message,
        }),
      );
    }

    return { invited, skipped };
  },

  /**
   * Accepts an invitation, turning it into membership.
   *
   * The `status = 'invited'` predicate on the UPDATE is the concurrency guard:
   * two taps both run, but only the first matches a row, so the count moves once.
   */
  async acceptInvite(groupId: number, userId: number): Promise<{ memberCount: number }> {
    const standing = await loadStanding(groupId, userId);
    const decision = decideMembershipAction('accept_invite', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    return db.transaction(async (tx) => {
      const updated = await tx
        .update(groupMemberships)
        .set({ status: 'active', joinedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(groupMemberships.groupId, groupId),
            eq(groupMemberships.userId, userId),
            eq(groupMemberships.status, 'invited'),
          ),
        )
        .returning({ id: groupMemberships.id });

      if (updated.length === 0) {
        throw Object.assign(new Error('You have no invitation to this group'), { statusCode: 404 });
      }

      const [group] = await tx
        .update(groups)
        .set({ memberCount: sql`${groups.memberCount} + 1` })
        .where(eq(groups.id, groupId))
        .returning({ memberCount: groups.memberCount });

      return { memberCount: group?.memberCount ?? 0 };
    });
  },

  /**
   * Declines an invitation by deleting the row.
   *
   * Deliberately not a `declined` status, unlike follow requests: nothing in the
   * design reads a declined state, and keeping the row would make every
   * re-invitation an update-or-insert against the unique index instead of a
   * plain insert. Re-inviting someone who declined is therefore allowed, and the
   * invite rate limiter is what stops that becoming a nuisance.
   */
  async declineInvite(groupId: number, userId: number): Promise<void> {
    const standing = await loadStanding(groupId, userId);
    const decision = decideMembershipAction('decline_invite', standing);
    if (!decision.allowed) {
      throw Object.assign(new Error(decision.message), { statusCode: decision.statusCode });
    }

    const deleted = await db
      .delete(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, groupId),
          eq(groupMemberships.userId, userId),
          eq(groupMemberships.status, 'invited'),
        ),
      )
      .returning({ id: groupMemberships.id });

    if (deleted.length === 0) {
      throw Object.assign(new Error('You have no invitation to this group'), { statusCode: 404 });
    }
    // No counter change — an invitation was never counted.
  },

  /**
   * Owner removes someone, whether they joined or are still invited.
   *
   * One endpoint covers both because the owner is doing the same thing either
   * way: severing that person's link to the group. The counter only moves if the
   * row being removed was an actual membership.
   *
   * Removing a member has nothing to do with the follow graph — it must never
   * unfollow anyone, whatever the confirmation dialog in the design says.
   */
  async removeMember(groupId: number, ownerId: number, targetUserId: number): Promise<void> {
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.ownerId, ownerId)))
      .limit(1);

    // Ownership folded into the lookup, so a non-owner cannot tell a group they
    // do not own from one that does not exist.
    if (!group) throw notFound();

    if (targetUserId === ownerId) {
      throw Object.assign(new Error('The owner cannot be removed from their own group'), {
        statusCode: 400,
      });
    }

    await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(groupMemberships)
        .where(
          and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, targetUserId)),
        )
        .returning({ status: groupMemberships.status });

      if (deleted.length === 0) {
        throw Object.assign(new Error('That person is not in this group'), { statusCode: 404 });
      }

      if (deleted[0].status === 'active') {
        await tx
          .update(groups)
          .set({ memberCount: sql`GREATEST(${groups.memberCount} - 1, 0)` })
          .where(eq(groups.id, groupId));
      }
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
