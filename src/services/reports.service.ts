import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users, posts, userReports } from '../db/schema';
import type { UserReport } from '../db/schema';
import { adminReportsService } from './admin/reports.service';

export const reportsService = {
  async create(
    reporterId: number,
    reportedUserId: number,
    reason: string,
    postId?: number,
  ): Promise<UserReport> {
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
      .values({ reporterId, reportedUserId, postId, reason })
      .returning();

    // Stamp the display reference and put it in front of a moderator. Awaited
    // rather than fired and forgotten: the reference is part of the row the
    // caller gets back, and a report nobody is told about is a report nobody
    // acts on.
    const [reporterRow] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, reporterId));

    const reference = await adminReportsService.onReportFiled(
      row.id,
      reportedUser.name,
      reporterRow?.name ?? 'Someone',
    );

    return { ...row, reference };
  },
};
