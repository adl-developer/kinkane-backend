import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db';
import {
  userReports,
  users,
  groups,
  groupMemberships,
  groupBooks,
  groupBookComments,
  comments,
  posts,
  books,
} from '../../db/schema';
import { enqueueEmail } from '../../lib/email-queue';
import { logger } from '../../lib/logger';
import { mentionsService } from '../mentions.service';

/**
 * What a moderator does about a report beyond dismissing it: hide the post,
 * review or comment it cites, or blacklist the group it is about. Both are
 * reversible and delete nothing, and both close every pending report about the
 * same thing — several people reporting one comment is one decision.
 */

function httpError(message: string, statusCode: number, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

type CitedColumn = typeof userReports.postId | typeof userReports.commentId | typeof userReports.groupCommentId;

/** The content a report cites, as the column that names it and its id. */
interface Cited {
  kind: 'post' | 'comment' | 'groupComment';
  id: number;
  column: CitedColumn;
}

async function loadCited(reportId: number): Promise<Cited> {
  const [report] = await db
    .select({
      postId: userReports.postId,
      commentId: userReports.commentId,
      groupCommentId: userReports.groupCommentId,
    })
    .from(userReports)
    .where(eq(userReports.id, reportId))
    .limit(1);
  if (!report) throw httpError('Report not found', 404);

  if (report.postId !== null) return { kind: 'post', id: report.postId, column: userReports.postId };
  if (report.commentId !== null) return { kind: 'comment', id: report.commentId, column: userReports.commentId };
  if (report.groupCommentId !== null) {
    return { kind: 'groupComment', id: report.groupCommentId, column: userReports.groupCommentId };
  }
  // Either the report never cited anything, or what it cited has since been
  // deleted (the ids are SET NULL). Both leave nothing to hide.
  throw httpError('This report does not cite a post or comment that still exists', 400, 'NOTHING_TO_HIDE');
}

/** Closes every pending report citing the same content, inside the caller's transaction. */
async function resolveReportsCiting(tx: Tx, cited: Cited, adminId: number): Promise<number[]> {
  const closed = await tx
    .update(userReports)
    .set({ status: 'resolved', resolvedBy: adminId, resolvedAt: new Date() })
    .where(and(eq(cited.column, cited.id), eq(userReports.status, 'pending')))
    .returning({ id: userReports.id });
  return closed.map((c) => c.id);
}

/** Who wrote a piece of content, and which book it is about, for the email. */
async function authorOf(cited: Cited): Promise<{ email: string; name: string; bookTitle: string | null; isReview: boolean } | undefined> {
  if (cited.kind === 'post') {
    const [row] = await db
      .select({ email: users.email, name: users.name, bookTitle: books.title, rating: posts.rating })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(eq(posts.id, cited.id));
    return row && { email: row.email, name: row.name, bookTitle: row.bookTitle, isReview: row.rating !== null };
  }
  if (cited.kind === 'comment') {
    const [row] = await db
      .select({ email: users.email, name: users.name, bookTitle: books.title })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.userId))
      .innerJoin(posts, eq(posts.id, comments.postId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(eq(comments.id, cited.id));
    return row && { ...row, isReview: false };
  }
  const [row] = await db
    .select({ email: users.email, name: users.name, bookTitle: books.title })
    .from(groupBookComments)
    .innerJoin(users, eq(users.id, groupBookComments.userId))
    .innerJoin(groupBooks, eq(groupBooks.id, groupBookComments.groupBookId))
    .innerJoin(books, eq(books.id, groupBooks.bookId))
    .where(eq(groupBookComments.id, cited.id));
  return row && { ...row, isReview: false };
}

export const adminModerationService = {
  /**
   * "Hide Review / Post / Comment" — the cited content is removed: gone for
   * everyone, its author included, who is emailed. Idempotent: hiding something
   * already hidden changes nothing and sends nothing, but still closes the
   * reports about it.
   *
   * A post is hidden by making it private, remembering whether it was public,
   * which takes it away from everyone else through the rules every read path
   * already applies to private posts; the author's own paths also check
   * hidden_at. The comment tables have no such flag and are filtered on
   * hidden_at directly.
   */
  async hide(reportId: number, adminId: number) {
    const cited = await loadCited(reportId);
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      let changed: boolean;
      if (cited.kind === 'post') {
        // The old value is read inside the UPDATE, so remembering it cannot
        // race with the author flipping visibility at the same moment.
        const updated = await tx
          .update(posts)
          .set({
            hiddenAt: now,
            hiddenBy: adminId,
            hiddenWasPublic: sql`${posts.isPublic}`,
            isPublic: false,
            updatedAt: now,
          })
          .where(and(eq(posts.id, cited.id), isNull(posts.hiddenAt)))
          .returning({ id: posts.id });
        changed = updated.length > 0;
      } else if (cited.kind === 'comment') {
        const updated = await tx
          .update(comments)
          .set({ hiddenAt: now, hiddenBy: adminId })
          .where(and(eq(comments.id, cited.id), isNull(comments.hiddenAt)))
          .returning({ id: comments.id });
        changed = updated.length > 0;
      } else {
        const updated = await tx
          .update(groupBookComments)
          .set({ hiddenAt: now, hiddenBy: adminId })
          .where(and(eq(groupBookComments.id, cited.id), isNull(groupBookComments.hiddenAt)))
          .returning({ id: groupBookComments.id });
        changed = updated.length > 0;
      }
      const resolvedReportIds = await resolveReportsCiting(tx, cited, adminId);
      return { changed, resolvedReportIds };
    });

    // After the commit, and never fatal: the content is hidden whether or not
    // the email goes out, and a moderator retrying would not resend it anyway.
    if (result.changed) {
      try {
        const author = await authorOf(cited);
        if (author) {
          await enqueueEmail('content-hidden', {
            to: author.email,
            name: author.name,
            kind: cited.kind === 'post' ? (author.isReview ? 'review' : 'post') : 'comment',
            bookTitle: author.bookTitle,
          });
        }
      } catch (err) {
        logger.error('Failed to enqueue content-hidden email', { reportId, error: (err as Error).message });
      }
    }

    return { kind: cited.kind, id: cited.id, hidden: true, ...result };
  },

  /**
   * Undoes hide. A post goes back to whatever visibility it had; its reports
   * stay resolved, since the decision was made and has now been reversed, not
   * left open. No email: the author was told it was hidden, and finding it
   * visible again needs no explanation.
   */
  async unhide(reportId: number) {
    const cited = await loadCited(reportId);
    let changed: boolean;
    let nowPublic = false;

    if (cited.kind === 'post') {
      const updated = await db
        .update(posts)
        .set({
          isPublic: sql`coalesce(${posts.hiddenWasPublic}, ${posts.isPublic})`,
          hiddenAt: null,
          hiddenBy: null,
          hiddenWasPublic: null,
          updatedAt: new Date(),
        })
        .where(and(eq(posts.id, cited.id), isNotNull(posts.hiddenAt)))
        .returning({ isPublic: posts.isPublic });
      changed = updated.length > 0;
      nowPublic = updated[0]?.isPublic ?? false;
    } else if (cited.kind === 'comment') {
      const updated = await db
        .update(comments)
        .set({ hiddenAt: null, hiddenBy: null })
        .where(and(eq(comments.id, cited.id), isNotNull(comments.hiddenAt)))
        .returning({ id: comments.id });
      changed = updated.length > 0;
    } else {
      const updated = await db
        .update(groupBookComments)
        .set({ hiddenAt: null, hiddenBy: null })
        .where(and(eq(groupBookComments.id, cited.id), isNotNull(groupBookComments.hiddenAt)))
        .returning({ id: groupBookComments.id });
      changed = updated.length > 0;
    }

    // Back in view: send the mention notifications held while it was hidden.
    // A post that comes back public releases its own and its comments', as when
    // its author makes it public; a comment releases its own. Only mentions not
    // yet delivered are sent, and the usual visibility rules still decide.
    if (changed) {
      if (cited.kind === 'post') {
        if (nowPublic) await mentionsService.releaseUnderPost(cited.id);
      } else {
        mentionsService.dispatchInBackground([{ type: cited.kind === 'comment' ? 'comment' : 'group_comment', id: cited.id }]);
      }
    }

    return { kind: cited.kind, id: cited.id, hidden: false, changed };
  },

  /**
   * "Blacklist Group" — the group disappears for everyone, owner and members
   * included, and each of them is emailed. Nothing is deleted. Closes every
   * pending report about the group.
   */
  async blacklistGroup(reportId: number, adminId: number) {
    const groupId = await reportedGroupOf(reportId);

    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(groups)
        .set({
          blacklistedAt: new Date(),
          blacklistedBy: adminId,
          blacklistReason: `Blacklisted from report ${reportId}`,
          updatedAt: new Date(),
        })
        .where(and(eq(groups.id, groupId), isNull(groups.blacklistedAt)))
        .returning({ id: groups.id, name: groups.name, ownerId: groups.ownerId });

      const closed = await tx
        .update(userReports)
        .set({ status: 'resolved', resolvedBy: adminId, resolvedAt: new Date() })
        .where(
          and(
            eq(userReports.targetType, 'group'),
            eq(userReports.reportedGroupId, groupId),
            eq(userReports.status, 'pending'),
          ),
        )
        .returning({ id: userReports.id });

      return { group: updated, resolvedReportIds: closed.map((c) => c.id) };
    });

    let emailed = 0;
    if (result.group) {
      try {
        emailed = await emailGroup(groupId, result.group.name, result.group.ownerId);
      } catch (err) {
        logger.error('Failed to enqueue group-blacklisted emails', { groupId, error: (err as Error).message });
      }
    }

    return {
      groupId,
      blacklisted: true,
      changed: result.group !== undefined,
      resolvedReportIds: result.resolvedReportIds,
      emailed,
    };
  },

  /** Lifts a group blacklist. The group comes back exactly as it was. */
  async unblacklistGroup(reportId: number) {
    const groupId = await reportedGroupOf(reportId);
    const updated = await db
      .update(groups)
      .set({ blacklistedAt: null, blacklistedBy: null, blacklistReason: null, updatedAt: new Date() })
      .where(and(eq(groups.id, groupId), isNotNull(groups.blacklistedAt)))
      .returning({ id: groups.id });
    return { groupId, blacklisted: false, changed: updated.length > 0 };
  },
};

async function reportedGroupOf(reportId: number): Promise<number> {
  const [report] = await db
    .select({ targetType: userReports.targetType, reportedGroupId: userReports.reportedGroupId })
    .from(userReports)
    .where(eq(userReports.id, reportId))
    .limit(1);
  if (!report) throw httpError('Report not found', 404);
  if (report.targetType !== 'group') {
    throw httpError('This report is not against a group, so there is no group to blacklist', 400, 'NOT_A_GROUP_REPORT');
  }
  // SET NULL when the group was deleted: the report survives, the group does not.
  if (report.reportedGroupId === null) throw httpError('The reported group no longer exists', 404);
  return report.reportedGroupId;
}

/** Emails the owner and every active member. Returns how many were sent. */
async function emailGroup(groupId: number, groupName: string, ownerId: number): Promise<number> {
  const members = await db
    .selectDistinct({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .leftJoin(
      groupMemberships,
      and(eq(groupMemberships.userId, users.id), eq(groupMemberships.groupId, groupId)),
    )
    .where(sql`${users.id} = ${ownerId} OR ${groupMemberships.status} = 'active'`);

  // In batches, so a large group does not open thousands of Redis writes at once.
  const BATCH = 100;
  for (let i = 0; i < members.length; i += BATCH) {
    await Promise.all(
      members.slice(i, i + BATCH).map((m) =>
        enqueueEmail('group-blacklisted', { to: m.email, name: m.name, groupName, isOwner: m.id === ownerId }),
      ),
    );
  }
  return members.length;
}
