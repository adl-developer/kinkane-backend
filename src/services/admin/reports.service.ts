import { aliasedTable, and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { userReports, users, groups } from '../../db/schema';
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
  async list(query: {
    status?: 'pending' | 'resolved' | 'dismissed';
    targetType?: 'user' | 'group';
    limit: number;
    offset: number;
  }) {
    const filters = [
      query.status ? eq(userReports.status, query.status) : undefined,
      query.targetType ? eq(userReports.targetType, query.targetType) : undefined,
    ].filter(Boolean) as SQL[];
    const where: SQL | undefined = filters.length ? and(...filters) : undefined;

    // Named rather than inlined into Promise.all: with two leftJoins the row
    // type gains nullable branches, and the tuple inference collapses to never
    // when all three queries are written as one array literal.
    const rowsQuery = db
        .select({
          id: userReports.id,
          reference: userReports.reference,
          status: userReports.status,
          reason: userReports.reason,
          postId: userReports.postId,
          targetType: userReports.targetType,
          filedAt: userReports.createdAt,
          resolvedAt: userReports.resolvedAt,
          // Selected flat rather than as nested objects: a leftJoin makes each
          // nested group nullable, and drizzle cannot type two of those at once.
          // The shapes are rebuilt below, which is also where "absent" becomes
          // an explicit null rather than an object full of nulls.
          reportedUserId: reported.id,
          reportedUserName: reported.name,
          reportedUserEmail: reported.email,
          reportedUserBlacklistedAt: reported.blacklistedAt,
          reportedGroupId: groups.id,
          reportedGroupName: groups.name,
          reportedById: reporter.id,
          reportedByName: reporter.name,
          reportedByEmail: reporter.email,
        })
        .from(userReports)
        // LEFT, not INNER. A group report has no reported user, and an INNER
        // join here would silently drop every one of them out of the queue —
        // a total, invisible moderation failure rather than a visible error.
        .leftJoin(reported, eq(reported.id, userReports.reportedUserId))
        .leftJoin(groups, eq(groups.id, userReports.reportedGroupId))
        // leftJoin, though reporter_id is NOT NULL and cascades — so this
        // returns exactly the same rows an innerJoin would. It is a typing
        // accommodation: drizzle cannot infer a select that mixes inner and
        // left joins, and collapses the row type to never.
        .leftJoin(reporter, eq(reporter.id, userReports.reporterId))
        .where(where)
        .orderBy(sql`case when ${userReports.status} = 'pending' then 0 else 1 end`, desc(userReports.createdAt))
        .limit(query.limit)
        .offset(query.offset);

    const totalQuery = db.select({ n: sql<number>`count(*)` }).from(userReports).where(where);
    const countsQuery = db
      .select({ status: userReports.status, n: sql<number>`count(*)` })
      .from(userReports)
      .groupBy(userReports.status);

    const [rows, [total], counts] = await Promise.all([rowsQuery, totalQuery, countsQuery]);

    const byStatus: Record<string, number> = { pending: 0, resolved: 0, dismissed: 0 };
    for (const c of counts) byStatus[c.status] = Number(c.n);

    return {
      reports: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        reason: r.reason,
        postId: r.postId,
        targetType: r.targetType,
        filedAt: r.filedAt,
        resolvedAt: r.resolvedAt,
        // Each is null for the kind of report it does not apply to, and
        // reportedGroup is null too once a reported group has been deleted —
        // the complaint outlives its target on purpose.
        reportedUser:
          r.reportedUserId !== null
            ? {
                id: r.reportedUserId,
                name: r.reportedUserName,
                email: r.reportedUserEmail,
                blacklistedAt: r.reportedUserBlacklistedAt,
                blacklisted: r.reportedUserBlacklistedAt !== null,
              }
            : null,
        reportedGroup:
          r.reportedGroupId !== null ? { id: r.reportedGroupId, name: r.reportedGroupName } : null,
        // Non-null in the payload. reporter_id is NOT NULL and the account
        // cascades, so a reporter always exists; only the left join above (a
        // typing accommodation, not a semantic change) makes it look optional.
        // Narrowing it here keeps one avoidable null out of every consumer —
        // reportedUser genuinely can be null, and that one is enough.
        reportedBy: {
          id: r.reportedById as number,
          name: r.reportedByName as string,
          email: r.reportedByEmail as string,
        },
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
      .select({
        id: userReports.id,
        targetType: userReports.targetType,
        reportedUserId: userReports.reportedUserId,
      })
      .from(userReports)
      .where(eq(userReports.id, reportId))
      .limit(1);

    if (!report) throw httpError('Report not found', 404);

    // There is nobody to blacklist on a group report. Refusing here keeps the
    // sweep below from ever running with a null target, which would close every
    // group report at once.
    if (report.targetType !== 'user' || report.reportedUserId === null) {
      throw httpError(
        'This report is not against a user, so there is no account to blacklist',
        400,
        'NOT_A_USER_REPORT',
      );
    }
    const reportedUserId = report.reportedUserId;

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
        reportedUserId,
        adminId,
        `Blacklisted from report ${reportId}`,
        tx,
      );

      const closed = await tx
        .update(userReports)
        .set({ status: 'resolved', resolvedBy: adminId, resolvedAt: new Date() })
        .where(
          and(
            // Scoped to user reports as well as to the person: without this a
            // group report whose reported_user_id is null could be swept up by
            // a NULL comparison as the shape of this table changes.
            eq(userReports.targetType, 'user'),
            eq(userReports.reportedUserId, reportedUserId),
            eq(userReports.status, 'pending'),
          ),
        )
        .returning({ id: userReports.id });

      return { resolvedReportIds: closed.map((c) => c.id), blacklistedUserId: reportedUserId };
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
  async onReportFiled(
    reportId: number,
    targetName: string,
    reporterName: string,
    targetType: 'user' | 'group' = 'user',
  ) {
    const reference = `R${String(reportId).padStart(3, '0')}`;
    await db.update(userReports).set({ reference }).where(eq(userReports.id, reportId));
    await adminNotificationsService.emit({
      type: 'report_filed',
      title: 'New report filed',
      body:
        targetType === 'group'
          ? `${reporterName} reported the group ${targetName}.`
          : `${reporterName} reported ${targetName}.`,
      reportId,
    });
    return reference;
  },
};
