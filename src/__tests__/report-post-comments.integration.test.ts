import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Reporting a comment under a community post, filed and then read back from
 * the moderation queue, against a real Postgres.
 *
 * What it guards: the comment must belong to the reported user, a comment under
 * someone else's private post must look like one that does not exist, only one
 * piece of content may be named per report, and the queue must show the
 * comment's text and post — the whole point of citing it.
 *
 * WHERE IT RUNS. TEST_DATABASE_URL, never DATABASE_URL — this suite deletes
 * users. Skips itself when unset; refuses to run when it names the same
 * database as `.env`. Setup as in nielsen-budget.integration.test.ts.
 */

const testUrl = process.env.TEST_DATABASE_URL;

function configuredUrl(): string | undefined {
  try {
    return dotenv.parse(readFileSync('.env')).DATABASE_URL;
  } catch {
    return undefined;
  }
}

function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

if (testUrl) {
  const configured = configuredUrl();
  if (configured && targetOf(configured) === targetOf(testUrl)) {
    throw new Error(
      `TEST_DATABASE_URL points at the same database as .env (${targetOf(testUrl)}). ` +
        'These tests delete rows — point them at a scratch database.',
    );
  }
  process.env.DATABASE_URL = testUrl;
}

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let reports: typeof import('../services/reports.service').reportsService;
let adminReports: typeof import('../services/admin/reports.service').adminReportsService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'report-post-comments-test-';
const BOOK_REF = 'report-post-comments-test-book';

describeIfDb('reporting a comment under a community post', () => {
  let reporterId: number;
  let authorId: number;
  let commenterId: number;
  let publicPostId: number;
  let privatePostId: number;
  let bookId: number;
  let commentId: number;
  let privateCommentId: number;

  async function cleanUp(): Promise<void> {
    // Posts, comments and reports all cascade from their users.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  }

  async function user(name: string): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, email) VALUES (${name}, ${`${EMAIL_PREFIX}${name.toLowerCase()}@example.com`}) RETURNING id
    `);
    return rows[0].id;
  }

  async function post(userId: number, isPublic: boolean): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO posts (user_id, book_id, body, status, is_public)
      VALUES (${userId}, ${bookId}, 'A post', 'reading', ${isPublic})
      RETURNING id
    `);
    return rows[0].id;
  }

  async function comment(postId: number, userId: number, body: string): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO comments (post_id, user_id, body) VALUES (${postId}, ${userId}, ${body}) RETURNING id
    `);
    return rows[0].id;
  }

  /**
   * This report's row in the moderation queue. The scratch database is shared
   * and never truncated, so the whole queue is read rather than one page of it:
   * a fixed page size would lose the row once other suites had filed enough.
   */
  async function queueRow(reportId: number) {
    const { total } = await adminReports.list({ limit: 1, offset: 0 });
    const { reports: queue } = await adminReports.list({ limit: total, offset: 0 });
    return queue.find((r) => r.id === reportId);
  }

  beforeAll(async () => {
    ({ sql } = await import('drizzle-orm'));
    ({ db } = await import('../db'));
    ({ reportsService: reports } = await import('../services/reports.service'));
    ({ adminReportsService: adminReports } = await import('../services/admin/reports.service'));

    await cleanUp();
    reporterId = await user('Reporter');
    authorId = await user('Author');
    const books = await db.execute<{ id: number }>(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'A book') RETURNING id
    `);
    bookId = books[0].id;
    commenterId = await user('Commenter');
    publicPostId = await post(authorId, true);
    privatePostId = await post(authorId, false);
    commentId = await comment(publicPostId, commenterId, 'Something nasty');
    privateCommentId = await comment(privatePostId, commenterId, 'Said in private');
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  it('files the report and shows the comment in the moderation queue', async () => {
    const report = await reports.create({
      targetType: 'user',
      reporterId,
      reportedUserId: commenterId,
      commentId,
      reason: 'Abusive comment',
    });
    expect(report.commentId).toBe(commentId);

    const row = await queueRow(report.id);
    expect(row?.cited).toEqual({ kind: 'comment', id: commentId, postId: publicPostId, body: 'Something nasty' });
    expect(row?.groupComment).toBeNull();
  });

  it('rejects a comment that is not the reported user\'s', async () => {
    await expect(
      reports.create({ targetType: 'user', reporterId, reportedUserId: authorId, commentId, reason: 'x' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('hides a comment under someone else\'s private post', async () => {
    await expect(
      reports.create({
        targetType: 'user',
        reporterId,
        reportedUserId: commenterId,
        commentId: privateCommentId,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets the private post\'s own author report a comment on it', async () => {
    const report = await reports.create({
      targetType: 'user',
      reporterId: authorId,
      reportedUserId: commenterId,
      commentId: privateCommentId,
      reason: 'Rude on my post',
    });
    expect(report.commentId).toBe(privateCommentId);
  });

  it('refuses a post and a comment in one report', async () => {
    await expect(
      reports.create({
        targetType: 'user',
        reporterId,
        reportedUserId: commenterId,
        postId: publicPostId,
        commentId,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('shows a cited post with its text, under the same field', async () => {
    const report = await reports.create({
      targetType: 'user',
      reporterId,
      reportedUserId: authorId,
      postId: publicPostId,
      reason: 'Spoilers',
    });
    expect((await queueRow(report.id))?.cited).toEqual({
      kind: 'post',
      id: publicPostId,
      postId: publicPostId,
      body: 'A post',
    });
  });

  it('keeps the report when the comment is deleted', async () => {
    const doomed = await comment(publicPostId, commenterId, 'Soon gone');
    const report = await reports.create({
      targetType: 'user',
      reporterId,
      reportedUserId: commenterId,
      commentId: doomed,
      reason: 'x',
    });
    await db.execute(sql`DELETE FROM comments WHERE id = ${doomed}`);

    expect((await queueRow(report.id))?.cited).toBeNull();
  });
});
