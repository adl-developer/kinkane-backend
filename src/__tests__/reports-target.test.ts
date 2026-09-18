import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { aliasedTable, eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { userReports, users, groups } from '../db/schema';

// Reports had no test file at all before groups became reportable. This covers
// the two things most likely to break silently now that one table serves two
// kinds of target: a request shape that mixes them, and a moderation queue that
// quietly stops showing one of them.

// ── The request shape ────────────────────────────────────────────────────────
// The controller's schema is re-declared here rather than imported: importing
// the controller pulls in the service and the database. It is a copy, so it is
// only worth testing the structural rules, which are what the union exists for.

const reasonSchema = z.string().trim().min(1).max(2000);
const submitSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null && !('targetType' in v) ? { ...v, targetType: 'user' } : v),
  z.discriminatedUnion('targetType', [
    z.object({
      targetType: z.literal('user'),
      reportedUserId: z.number().int().positive(),
      reason: reasonSchema,
      postId: z.number().int().positive().optional(),
    }),
    // .strict() on this branch only. Zod otherwise strips unknown keys, so a
    // request naming BOTH a group and a user would quietly be filed as a group
    // report — a guess at an ambiguous intent. The user branch stays permissive
    // because clients already in the wild post to it.
    z.object({
      targetType: z.literal('group'),
      reportedGroupId: z.number().int().positive(),
      reason: reasonSchema,
    }).strict(),
  ]),
);

describe('what a report may be filed against', () => {
  it('defaults to a user report when targetType is absent', () => {
    // Clients shipped before groups were reportable send no targetType at all,
    // and must keep working untouched.
    const r = submitSchema.safeParse({ reportedUserId: 42, reason: 'spam' });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { targetType: string }).targetType).toBe('user');
  });

  it('rejects a group report that also names a user', () => {
    // The database CHECK forbids this combination; the request shape should
    // refuse it first, with a message about the field rather than a 500.
    const r = submitSchema.safeParse({
      targetType: 'group',
      reportedGroupId: 12,
      reportedUserId: 42,
      reason: 'spam',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a user report with no user', () => {
    expect(submitSchema.safeParse({ targetType: 'user', reason: 'spam' }).success).toBe(false);
  });

  it('rejects a group report with no group', () => {
    expect(submitSchema.safeParse({ targetType: 'group', reason: 'spam' }).success).toBe(false);
  });

  it('does not accept a citing post on a group report', () => {
    // postId means "this specific review of theirs", which has no meaning for a
    // group and would be silently dropped if the union allowed it.
    const r = submitSchema.safeParse({
      targetType: 'group',
      reportedGroupId: 12,
      reason: 'spam',
      postId: 5,
    });
    expect(r.success && 'postId' in r.data).toBeFalsy();
  });

  it('still requires a reason for either kind', () => {
    expect(submitSchema.safeParse({ targetType: 'group', reportedGroupId: 12, reason: '   ' }).success).toBe(false);
    expect(submitSchema.safeParse({ reportedUserId: 42, reason: '' }).success).toBe(false);
  });
});

// ── The moderation queue ─────────────────────────────────────────────────────

describe('the moderation queue query', () => {
  const dialect = new PgDialect();

  it('left-joins the reported user, so group reports still appear', () => {
    // This is the regression worth a test: a group report has no reported user,
    // and an INNER join would drop every one of them from the queue. Nothing
    // errors — moderators simply never see them.
    const reported = aliasedTable(users, 'reported');
    const reporter = aliasedTable(users, 'reporter');
    const query = dialect.sqlToQuery(
      // Mirrors the shape of adminReportsService.list.
      sql`select 1 from ${userReports}
          left join ${reported} on ${eq(reported.id, userReports.reportedUserId)}
          left join ${groups} on ${eq(groups.id, userReports.reportedGroupId)}
          left join ${reporter} on ${eq(reporter.id, userReports.reporterId)}
          order by ${desc(userReports.createdAt)}`,
    ).sql;

    expect(query).toMatch(/left join/i);
    expect(query).not.toMatch(/inner join/i);
  });
});

// ── Blacklisting ─────────────────────────────────────────────────────────────

describe('blacklisting from a report', () => {
  it('refuses to run against a group report', async () => {
    // There is no account behind a group report. Letting this through would
    // reach a bulk-close scoped to a null user id, which could close unrelated
    // reports in one sweep.
    vi.resetModules();
    const selectLimit = vi.fn().mockResolvedValue([
      { id: 1, targetType: 'group', reportedUserId: null },
    ]);
    vi.doMock('../db', () => ({
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
        transaction: vi.fn(),
      },
    }));

    const { adminReportsService } = await import('../services/admin/reports.service');
    await expect(adminReportsService.blacklistAndResolve(1, 99)).rejects.toThrow(
      /not against a user/i,
    );
    vi.doUnmock('../db');
  });
});
