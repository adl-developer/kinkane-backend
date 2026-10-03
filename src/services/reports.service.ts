import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { users, posts, groups, groupBooks, groupBookComments, groupMemberships, userReports } from '../db/schema';
import type { UserReport } from '../db/schema';
import { adminReportsService } from './admin/reports.service';
import { groupViewerCapabilities } from './groups.service';

/**
 * What is being reported. A discriminated union rather than a bag of optional
 * ids, so "a group report carrying a reportedUserId" cannot be expressed.
 */
export type CreateReportInput =
  | {
      targetType: 'user';
      reporterId: number;
      reportedUserId: number;
      reason: string;
      postId?: number;
      /** A group book-club comment the report is about — the comment's "…" menu. */
      groupCommentId?: number;
    }
  | { targetType: 'group'; reporterId: number; reportedGroupId: number; reason: string };

export const reportsService = {
  async create(input: CreateReportInput): Promise<UserReport> {
    const { reporterId, reason } = input;

    const [reporterRow] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, reporterId));
    const reporterName = reporterRow?.name ?? 'Someone';

    if (input.targetType === 'group') {
      const [group] = await db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(eq(groups.id, input.reportedGroupId));
      if (!group) {
        throw Object.assign(new Error('Reported group not found'), { statusCode: 404 });
      }

      // Reporting a group you own is pointless rather than harmful, so there is
      // no equivalent of the self-report guard — inventing a rule to block it
      // would only produce a confusing error for a harmless act.
      const [row] = await db
        .insert(userReports)
        .values({
          targetType: 'group',
          reporterId,
          reportedGroupId: input.reportedGroupId,
          reason,
        })
        .returning();

      const reference = await adminReportsService.onReportFiled(row.id, group.name, reporterName, 'group');
      return { ...row, reference };
    }

    const { reportedUserId, postId, groupCommentId } = input;

    // One piece of content per report. Naming a post and a comment at once is
    // ambiguous about which one the moderator is meant to read.
    if (postId !== undefined && groupCommentId !== undefined) {
      throw Object.assign(new Error('A report can name a post or a group comment, not both'), { statusCode: 400 });
    }

    if (reporterId === reportedUserId) {
      throw Object.assign(new Error('You cannot report yourself'), { statusCode: 400 });
    }

    const [reportedUser] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, reportedUserId));
    if (!reportedUser) {
      throw Object.assign(new Error('Reported user not found'), { statusCode: 404 });
    }

    if (postId !== undefined) {
      const [post] = await db
        .select({ id: posts.id, userId: posts.userId })
        .from(posts)
        .where(eq(posts.id, postId));
      if (!post) {
        throw Object.assign(new Error('Post not found'), { statusCode: 404 });
      }
      if (post.userId !== reportedUserId) {
        throw Object.assign(new Error('Post does not belong to the reported user'), { statusCode: 400 });
      }
    }

    if (groupCommentId !== undefined) {
      // The comment's group and the reporter's standing in it, in one round
      // trip, so a comment the reporter cannot see is indistinguishable from
      // one that does not exist. Without this, a stranger to a private club
      // could walk comment ids and user ids and learn from 404 / 400 / 201
      // who said what in there — filing a report on every hit.
      const [comment] = await db
        .select({
          userId: groupBookComments.userId,
          ownerId: groups.ownerId,
          privacy: groups.privacy,
          reporterStatus: groupMemberships.status,
        })
        .from(groupBookComments)
        .innerJoin(groupBooks, eq(groupBooks.id, groupBookComments.groupBookId))
        .innerJoin(groups, eq(groups.id, groupBooks.groupId))
        .leftJoin(
          groupMemberships,
          and(eq(groupMemberships.groupId, groups.id), eq(groupMemberships.userId, reporterId)),
        )
        .where(eq(groupBookComments.id, groupCommentId));
      if (!comment || !groupViewerCapabilities(comment, comment.reporterStatus ?? null, reporterId).canSeeShelf) {
        throw Object.assign(new Error('Comment not found'), { statusCode: 404 });
      }
      if (comment.userId !== reportedUserId) {
        throw Object.assign(new Error('Comment does not belong to the reported user'), { statusCode: 400 });
      }
    }

    const [row] = await db
      .insert(userReports)
      .values({ targetType: 'user', reporterId, reportedUserId, postId, groupCommentId, reason })
      .returning();

    // Stamp the display reference and put it in front of a moderator. Awaited
    // rather than fired and forgotten: the reference is part of the row the
    // caller gets back, and a report nobody is told about is a report nobody
    // acts on.
    const reference = await adminReportsService.onReportFiled(
      row.id,
      reportedUser.name,
      reporterName,
      'user',
    );

    return { ...row, reference };
  },
};
