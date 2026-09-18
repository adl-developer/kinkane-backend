import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, posts, groups, userReports } from '../db/schema';
import type { UserReport } from '../db/schema';
import { adminReportsService } from './admin/reports.service';

/**
 * What is being reported. A discriminated union rather than a bag of optional
 * ids, so "a group report carrying a reportedUserId" cannot be expressed.
 */
export type CreateReportInput =
  | { targetType: 'user'; reporterId: number; reportedUserId: number; reason: string; postId?: number }
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

    const { reportedUserId, postId } = input;

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

    const [row] = await db
      .insert(userReports)
      .values({ targetType: 'user', reporterId, reportedUserId, postId, reason })
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
