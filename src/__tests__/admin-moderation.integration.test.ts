import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * The moderation screen end to end, against a real Postgres: reports filed
 * onto their tabs with their own reference series, the queue as the console
 * reads it, and the two actions beyond dismissing — hiding a post, review or
 * comment, and blacklisting a group — including who can still see what
 * afterwards and who is emailed.
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

const enqueueEmail = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/email-queue', () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args), bullConnection: {} }));
vi.mock('../lib/push-queue', () => ({ enqueuePush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/notification-preferences.service', () => ({
  notificationPreferencesService: { isEnabled: vi.fn().mockResolvedValue(false) },
}));

let db: typeof import('../db').db;
let sql: typeof import('drizzle-orm').sql;
let reports: typeof import('../services/reports.service').reportsService;
let adminReports: typeof import('../services/admin/reports.service').adminReportsService;
let moderation: typeof import('../services/admin/moderation.service').adminModerationService;
let community: typeof import('../services/community.service').communityService;
let groupsService: typeof import('../services/groups.service').groupsService;
let groupBooks: typeof import('../services/group-books.service').groupBooksService;

const describeIfDb = testUrl ? describe : describe.skip;
const EMAIL_PREFIX = 'admin-moderation-test-';
const BOOK_REF = 'admin-moderation-test-book';

describeIfDb('the moderation screen', () => {
  let ama: number; // reporter
  let kofi: number; // author / group owner
  let esi: number; // bystander and group member
  let bookId: number;

  async function cleanUp(): Promise<void> {
    // Posts, comments, groups and reports all cascade from their users.
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL_PREFIX + '%'}`);
    await db.execute(sql`DELETE FROM books WHERE record_reference = ${BOOK_REF}`);
  }

  async function user(name: string): Promise<number> {
    const rows = await db.execute<{ id: number }>(sql`
      INSERT INTO users (name, email, email_verified, shelf_visibility)
      VALUES (${name}, ${`${EMAIL_PREFIX}${name.toLowerCase()}@example.com`}, true, 'public')
      RETURNING id
    `);
    return rows[0].id;
  }

  async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
    try {
      await promise;
      return 'ok';
    } catch (err) {
      return (err as { statusCode?: number }).statusCode ?? 500;
    }
  }

  /** This report's row in the moderation queue, reading the whole queue. */
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
    ({ adminModerationService: moderation } = await import('../services/admin/moderation.service'));
    ({ communityService: community } = await import('../services/community.service'));
    ({ groupsService } = await import('../services/groups.service'));
    ({ groupBooksService: groupBooks } = await import('../services/group-books.service'));
  });

  beforeEach(async () => {
    await cleanUp();
    enqueueEmail.mockClear();
    ama = await user('Ama');
    kofi = await user('Kofi');
    esi = await user('Esi');
    const books = await db.execute<{ id: number }>(sql`
      INSERT INTO books (record_reference, title) VALUES (${BOOK_REF}, 'The Midnight Library') RETURNING id
    `);
    bookId = books[0].id;
  });

  afterAll(async () => {
    if (db) await cleanUp();
  });

  // ── Filing ─────────────────────────────────────────────────────────────────

  it('files each report onto its tab, with its own reference series and the app’s reason label', async () => {
    const { id: postId } = await community.createPost(kofi, { bookId, status: 'read', rating: 1, body: 'Awful', isPublic: true });
    const group = await groupsService.create(kofi, { name: 'Night Readers', privacy: 'public' });

    const person = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, reason: 'Rude in DMs' });
    const content = await reports.create({
      targetType: 'user', reporterId: ama, reportedUserId: kofi, postId, reason: 'Abusive review', reasonCategory: 'Harassment',
    });
    const club = await reports.create({
      targetType: 'group', reporterId: ama, reportedGroupId: group.id, reason: 'Spam links', reasonCategory: 'Spam / Unsolicited promotion',
    });

    expect([person.category, content.category, club.category]).toEqual(['user', 'content', 'group']);
    expect(person.reference).toMatch(/^R\d{3,}$/);
    expect(content.reference).toMatch(/^CR\d{3,}$/);
    expect(club.reference).toMatch(/^GR\d{3,}$/);
    expect(content.reasonCategory).toBe('Harassment');

    const { reports: contentTab, pendingByCategory } = await adminReports.list({ category: 'content', limit: 100, offset: 0 });
    expect(contentTab.every((r) => r.category === 'content')).toBe(true);
    expect(contentTab.some((r) => r.id === content.id)).toBe(true);
    expect(pendingByCategory.content).toBeGreaterThanOrEqual(1);
    expect(pendingByCategory.group).toBeGreaterThanOrEqual(1);
  });

  it('shows a review as a review, with its book, and a group with its member count', async () => {
    const { id: review } = await community.createPost(kofi, { bookId, status: 'read', rating: 1, body: 'Awful', isPublic: true });
    const { id: post } = await community.createPost(kofi, { bookId, status: 'reading', body: 'Halfway', isPublic: true });
    const group = await groupsService.create(kofi, { name: 'Night Readers', privacy: 'public' });

    const r1 = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, postId: review, reason: 'x' });
    const r2 = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, postId: post, reason: 'x' });
    const r3 = await reports.create({ targetType: 'group', reporterId: ama, reportedGroupId: group.id, reason: 'x' });

    expect((await queueRow(r1.id))?.cited).toMatchObject({
      kind: 'review', id: review, body: 'Awful', hidden: false, book: { id: bookId, title: 'The Midnight Library' },
    });
    expect((await queueRow(r2.id))?.cited).toMatchObject({ kind: 'post', id: post });
    expect((await queueRow(r3.id))?.reportedGroup).toMatchObject({ id: group.id, name: 'Night Readers', memberCount: 1, blacklisted: false });
  });

  it('emails staff about each new report, described as it was filed', async () => {
    const { id: review } = await community.createPost(kofi, { bookId, status: 'read', rating: 1, body: 'Awful', isPublic: true });
    const { id: post } = await community.createPost(esi, { bookId, status: 'read', rating: 4, body: 'Loved it', isPublic: true });
    const comment = await community.addComment(post, kofi, 'You have terrible taste');
    const group = await groupsService.create(kofi, { name: 'Night Readers', privacy: 'public' });
    enqueueEmail.mockClear();

    const r1 = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, reason: 'Keeps messaging me', reasonCategory: 'Harassment' });
    const r2 = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, postId: review, reason: 'Spoilers' });
    const r3 = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, commentId: comment.id, reason: 'Rude' });
    const r4 = await reports.create({ targetType: 'group', reporterId: ama, reportedGroupId: group.id, reason: 'Spam', reasonCategory: 'Spam' });

    const payloads = enqueueEmail.mock.calls.filter(([name]) => name === 'report-filed').map(([, data]) => (data as { payload: Record<string, unknown> }).payload);
    expect(payloads).toHaveLength(4);
    const reporter = { name: 'Ama', username: null };
    expect(payloads[0]).toMatchObject({
      reference: r1.reference, category: 'user', reporter, reportedUser: { name: 'Kofi' },
      reasonCategory: 'Harassment', reason: 'Keeps messaging me',
    });
    expect(payloads[1]).toMatchObject({ reference: r2.reference, category: 'content', contentKind: 'review', author: { name: 'Kofi' }, excerpt: 'Awful' });
    expect(payloads[2]).toMatchObject({ reference: r3.reference, category: 'content', contentKind: 'comment', excerpt: 'You have terrible taste' });
    expect(payloads[3]).toMatchObject({
      reference: r4.reference, category: 'group', groupName: 'Night Readers', owner: { name: 'Kofi' }, memberCount: 1,
    });
    expect(Date.parse(payloads[0].filedAt as string)).not.toBeNaN();
  });

  it('still files the report when the staff email cannot be queued', async () => {
    enqueueEmail.mockRejectedValueOnce(new Error('redis down'));
    const report = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, reason: 'x' });
    expect(report.reference).toMatch(/^R\d{3,}$/);
  });

  // ── Hiding ─────────────────────────────────────────────────────────────────

  it('hides a review from everyone but its author, closes its reports, and emails the author', async () => {
    const { id: postId } = await community.createPost(kofi, { bookId, status: 'read', rating: 1, body: 'Awful', isPublic: true });
    const first = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, postId, reason: 'x' });
    const second = await reports.create({ targetType: 'user', reporterId: esi, reportedUserId: kofi, postId, reason: 'y' });
    // Filing queued the staff emails; only what hiding sends is counted below.
    enqueueEmail.mockClear();

    const result = await moderation.hide(first.id, 1);
    expect(result).toMatchObject({ kind: 'post', hidden: true, changed: true });
    expect(result.resolvedReportIds.sort()).toEqual([first.id, second.id].sort());

    expect(await status(community.getPost(postId, ama))).toBe(404);
    const forAuthor = await community.getPost(postId, kofi);
    expect(forAuthor).toMatchObject({ isHidden: true, isPublic: false });
    const onBook = await community.listPostsForBook(bookId, esi, 'date_desc', 20, 0);
    expect(onBook.posts.map((p) => p.id)).not.toContain(postId);

    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledWith('content-hidden', expect.objectContaining({
      to: `${EMAIL_PREFIX}kofi@example.com`, kind: 'review', bookTitle: 'The Midnight Library',
    }));

    // Again: nothing changes and nobody is emailed twice.
    expect(await moderation.hide(first.id, 1)).toMatchObject({ changed: false });
    expect(enqueueEmail).toHaveBeenCalledTimes(1);

    // Undone: public again, as it was.
    expect(await moderation.unhide(first.id)).toMatchObject({ hidden: false, changed: true });
    expect(await community.getPost(postId, ama)).toMatchObject({ isHidden: false, isPublic: true });
  });

  it('keeps a hidden post private when its author makes it public, and honours that on unhide', async () => {
    const { id: postId } = await community.createPost(kofi, { bookId, status: 'read', rating: 2, body: 'Meh', isPublic: false });
    const report = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, postId, reason: 'x' });
    await moderation.hide(report.id, 1);

    await community.updatePost(postId, kofi, { isPublic: true });
    expect(await status(community.getPost(postId, ama))).toBe(404);

    await moderation.unhide(report.id);
    expect(await community.getPost(postId, ama)).toMatchObject({ isPublic: true });
  });

  it('hides a comment under a post from everyone but its author, and out of the count', async () => {
    const { id: postId } = await community.createPost(esi, { bookId, status: 'read', rating: 4, body: 'Loved it', isPublic: true });
    const comment = await community.addComment(postId, kofi, 'You have terrible taste');
    const report = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, commentId: comment.id, reason: 'x' });

    await moderation.hide(report.id, 1);

    expect((await community.listComments(postId, ama, 20, 0)).comments).toHaveLength(0);
    expect((await community.getPost(postId, ama)).commentCount).toBe(0);
    const forAuthor = await community.listComments(postId, kofi, 20, 0);
    expect(forAuthor.comments).toEqual([expect.objectContaining({ id: comment.id, isHidden: true })]);
    expect(await status(community.likeComment(comment.id, ama))).toBe(404);
    expect(enqueueEmail).toHaveBeenCalledWith('content-hidden', expect.objectContaining({ kind: 'comment' }));
  });

  it('hides a book-club comment and its replies from everyone but its author', async () => {
    const group = await groupsService.create(esi, { name: 'Night Readers', privacy: 'public' });
    await db.execute(sql`
      INSERT INTO group_memberships (group_id, user_id, status, joined_at)
      VALUES (${group.id}, ${ama}, 'active', now()), (${group.id}, ${kofi}, 'active', now())
    `);
    const shelf = await groupBooks.setCurrent(group.id, esi, { bookId, startedOn: '2026-10-01' });
    const comment = await groupBooks.addComment(group.id, shelf.id, kofi, 'Go back to cereal boxes');
    await groupBooks.addComment(group.id, shelf.id, esi, 'Steady on', comment.id);
    const report = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, groupCommentId: comment.id, reason: 'x' });

    await moderation.hide(report.id, 1);

    expect((await groupBooks.listComments(group.id, shelf.id, ama, 20, 0)).comments).toHaveLength(0);
    expect(await status(groupBooks.listReplies(group.id, comment.id, ama, 20, 0))).toBe(404);
    expect(await status(groupBooks.likeComment(group.id, comment.id, ama))).toBe(404);
    const forAuthor = await groupBooks.listComments(group.id, shelf.id, kofi, 20, 0);
    expect(forAuthor.comments).toEqual([expect.objectContaining({ id: comment.id, isHidden: true })]);
  });

  it('refuses to hide when a report cites nothing', async () => {
    const report = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, reason: 'x' });
    expect(await status(moderation.hide(report.id, 1))).toBe(400);
  });

  // ── Blacklisting a group ───────────────────────────────────────────────────

  it('takes a blacklisted group away from everyone, emails owner and members, and gives it back', async () => {
    const group = await groupsService.create(kofi, { name: 'Night Readers', privacy: 'public' });
    await db.execute(sql`
      INSERT INTO group_memberships (group_id, user_id, status, joined_at) VALUES (${group.id}, ${esi}, 'active', now())
    `);
    const first = await reports.create({ targetType: 'group', reporterId: ama, reportedGroupId: group.id, reason: 'x' });
    const second = await reports.create({ targetType: 'group', reporterId: esi, reportedGroupId: group.id, reason: 'y' });

    const result = await moderation.blacklistGroup(first.id, 1);
    expect(result).toMatchObject({ blacklisted: true, changed: true, emailed: 2 });
    expect(result.resolvedReportIds.sort()).toEqual([first.id, second.id].sort());

    for (const viewer of [kofi, esi, ama]) expect(await status(groupsService.get(group.id, viewer))).toBe(404);
    expect((await groupsService.list(50, 0, 'Night Readers')).groups.map((g) => g.id)).not.toContain(group.id);
    expect((await groupsService.listForUser(kofi, kofi, 50, 0)).groups.map((g) => g.id)).not.toContain(group.id);
    expect(await status(groupsService.join(group.id, ama))).toBe(404);
    expect(await status(groupsService.remove(group.id, kofi))).toBe(404);

    const emails = enqueueEmail.mock.calls.filter(([name]) => name === 'group-blacklisted').map(([, data]) => data);
    expect(emails).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: `${EMAIL_PREFIX}kofi@example.com`, isOwner: true, groupName: 'Night Readers' }),
      expect.objectContaining({ to: `${EMAIL_PREFIX}esi@example.com`, isOwner: false }),
    ]));
    expect((await queueRow(first.id))?.reportedGroup).toMatchObject({ blacklisted: true });

    expect(await moderation.unblacklistGroup(first.id)).toMatchObject({ blacklisted: false, changed: true });
    expect(await status(groupsService.get(group.id, esi))).toBe('ok');
  });

  it('refuses to blacklist a group from a report about a person', async () => {
    const report = await reports.create({ targetType: 'user', reporterId: ama, reportedUserId: kofi, reason: 'x' });
    expect(await status(moderation.blacklistGroup(report.id, 1))).toBe(400);
  });
});
