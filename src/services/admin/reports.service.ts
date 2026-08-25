import { aliasedTable, and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { userReports, users } from '../../db/schema';
import { adminCustomersService } from './customers.service';
import { adminNotificationsService } from './notifications.service';

const reporter = aliasedTable(users, 'reporter');
const reported = aliasedTable(users, 'reported');

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

export const adminReportsService = {
  /**
   * The moderation queue.
   *
   * Ordered pending-first and then newest-first, because the screen is a
   * worklist: everything still needing a decision belongs at the top regardless
   * of age.
   */
  async list(query: { status?: 'pending' | 'resolved' | 'dismissed'; limit: number; offset: number }) {
    const where: SQL | undefined = query.status ? eq(userReports.status, query.status) : undefined;

    const [rows, [total], counts] = await Promise.all([
      db
        .select({
          id: userReports.id,
          reference: userReports.reference,
          status: userReports.status,
          reason: userReports.reason,
          postId: userReports.postId,
          filedAt: userReports.createdAt,
          resolvedAt: userReports.resolvedAt,
          reportedUser: {
            id: reported.id,
            name: reported.name,
            email: reported.email,
            blacklistedAt: reported.blacklistedAt,
          },
          reportedBy: { id: reporter.id, name: reporter.name, email: reporter.email },
        })
        .from(userReports)
        .innerJoin(reported, eq(reported.id, userReports.reportedUserId))
        .innerJoin(reporter, eq(reporter.id, userReports.reporterId))
        .where(where)
        .orderBy(sql`case when ${userReports.status} = 'pending' then 0 else 1 end`, desc(userReports.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ n: sql<number>`count(*)` }).from(userReports).where(where),
      db.select({ status: userReports.status, n: sql<number>`count(*)` }).from(userReports).groupBy(userReports.status),
    ]);

    const byStatus: Record<string, number> = { pending: 0, resolved: 0, dismissed: 0 };
    for (const c of counts) byStatus[c.status] = Number(c.n);

    return {
      reports: rows.map((r) => ({
        ...r,
        reportedUser: { ...r.reportedUser, blacklisted: r.reportedUser.blacklistedAt !== null },
      })),
      total: Number(total.n),
      counts: byStatus,
    };
  },

  /** "Dismiss" — the complaint was looked at and no action taken. */
  async dismiss(reportId: number, adminId: number) {
    return this.close(reportId, adminId, 'dismissed');
  },

  /**
   * "Blacklist User" — blocks the reported account and closes the report.
   *
   * Closes **every** pending report against that user, not just this one. Three
   * people reporting the same person is one decision, and leaving the other two
   * in the queue means the next admin re-reviews an account that is already
   * blocked.
   */
  async blacklistAndResolve(reportId: number, adminId: number) {
    const [report] = await db
      .select({ id: userReports.id, reportedUserId: userReports.reportedUserId })
      .from(userReports)
      .where(eq(userReports.id, reportId))
      .limit(1);

    if (!report) throw httpError('Report not found', 404);

    // One decision, so one unit of work. Split, a failure between the two
    // leaves a blacklisted customer whose reports are still sitting in the
    // queue — so the next admin reviews an account that is already blocked and
    // blocks it again — or, worse the other way, reports marked resolved
    // against someone who was never actually blocked.
    //
    // blacklist() is handed *this* transaction rather than opening its own.
    // Under postgres-js a nested db.transaction() takes a separate connection,
    // which would make the two writes non-atomic and deadlock the moment both
    // touched the same users row.
    const result = await db.transaction(async (tx) => {
      await adminCustomersService.blacklist(
        report.reportedUserId,
        adminId,
        `Blacklisted from report ${reportId}`,
        tx,
      );

      const closed = await tx
        .update(userReports)
        .set({ status: 'resolved', resolvedBy: adminId, resolvedAt: new Date() })
        .where(
          and(
            eq(userReports.reportedUserId, report.reportedUserId),
            eq(userReports.status, 'pending'),
          ),
        )
        .returning({ id: userReports.id });

      return { resolvedReportIds: closed.map((c) => c.id), blacklistedUserId: report.reportedUserId };
    });

    return result;
  },

  async close(reportId: number, adminId: number, status: 'resolved' | 'dismissed') {
    const [updated] = await db
      .update(userReports)
      .set({ status, resolvedBy: adminId, resolvedAt: new Date() })
      .where(eq(userReports.id, reportId))
      .returning({ id: userReports.id, status: userReports.status });

    if (!updated) throw httpError('Report not found', 404);
    return updated;
  },

  /**
   * Called when a customer files a report. Stamps the reference and tells the
   * console, so a complaint cannot sit unseen.
   */
  async onReportFiled(reportId: number, reportedUserName: string, reporterName: string) {
    const reference = `R${String(reportId).padStart(3, '0')}`;
    await db.update(userReports).set({ reference }).where(eq(userReports.id, reportId));
    await adminNotificationsService.emit({
      type: 'report_filed',
      title: 'New report filed',
      body: `${reporterName} reported ${reportedUserName}.`,
      reportId,
    });
    return reference;
  },
};
