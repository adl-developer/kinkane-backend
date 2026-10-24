import { eq, and, or, asc, desc, sql, inArray, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { posts, postLikes, comments, commentLikes, users, books, userBooks, bookContributors, notifications } from '../db/schema';
import { getExcerptsByIsbns, pickExcerpt, type BookExcerptInfo } from './book-excerpts.service';
import { notificationPreferencesService } from './notification-preferences.service';
import { enqueuePush } from '../lib/push-queue';
import { logger } from '../lib/logger';
import { mentionsService, renderTexts } from './mentions.service';
import { assertCanViewShelf, canViewShelfBook } from './users.service';
import { accountActive, isHiddenFrom, notBlockedBetween } from './blocks.service';
import type { MentionRef } from '../lib/mention-text';
import type { LinkRef } from '../lib/link-text';
import { isEdited, withEditState } from '../lib/edit-state';
import { TEXT_LIMITS } from '../lib/text-limits';

const COMMENT_PREVIEW_LENGTH = 140;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreatePostFields {
  bookId: number;
  /** Null or absent only when `status` is `reading`. */
  rating?: number | null;
  status: 'reading' | 'read';
  body?: string;
  isPublic: boolean;
}

export interface PostItem {
  id: number;
  userId: number;
  userName: string;
  userUsername: string | null;
  userPhotoUrl: string | null;
  bookId: number;
  bookTitle: string;
  bookCoverUrl: string | null;
  bookExcerpt: BookExcerptInfo | null;
  /** Null on a `reading` post the author hasn't rated yet. */
  rating: number | null;
  status: 'reading' | 'read';
  body: string | null;
  /** Linked @handles in `body`, by UTF-16 offset. */
  mentions: MentionRef[];
  links: LinkRef[];
  isPublic: boolean;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: Date;
  /** Bumped by any change, including a visibility switch — not an edit marker. */
  updatedAt: Date;
  /** True once the author has changed the body, rating or status. */
  isEdited: boolean;
  /** When the body, rating or status last changed; null if never edited. */
  editedAt: Date | null;
}

export interface FriendBookDetail {
  bookId: number;
  bookTitle: string;
  bookCoverUrl: string | null;
  bookExcerpt: BookExcerptInfo | null;
  contributors: { personName: string | null; role: string | null }[];
  friendName: string;
  friendUsername: string | null;
  friendPhotoUrl: string | null;
  rating: number | null;
  review: string | null;
  reviewMentions: MentionRef[];
  reviewLinks: LinkRef[];
  /** True once the friend has changed that review's body, rating or status. */
  reviewIsEdited: boolean;
  reviewEditedAt: Date | null;
  note: string | null;
  noteMentions: MentionRef[];
  noteLinks: LinkRef[];
}

export interface CommentItem {
  id: number;
  postId: number;
  userId: number;
  userName: string;
  userUsername: string | null;
  userPhotoUrl: string | null;
  body: string;
  mentions: MentionRef[];
  links: LinkRef[];
  likeCount: number;
  likedByMe: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** True once the author has changed the body. */
  isEdited: boolean;
  editedAt: Date | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The comments `requesterId` may see: none across a block either way, old ones
 * included, none a moderator has hidden (from its author too), and none by a
 * blacklisted account. Counts use it too, so `commentCount` always matches the
 * list.
 */
function commentVisibleTo(requesterId: number): SQL {
  return and(
    notBlockedBetween(requesterId, comments.userId),
    isNull(comments.hiddenAt),
    accountActive(comments.userId),
  )!;
}

function assertFound<T>(row: T | undefined, label: string): T {
  if (!row) throw Object.assign(new Error(`${label} not found`), { statusCode: 404 });
  return row;
}

// Returns 404 (not 403) so private resource existence is never leaked.
function assertOwner(ownerId: number, requesterId: number): void {
  if (ownerId !== requesterId) {
    throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  }
}

function assertPostVisible(post: { isPublic: boolean; userId: number }, requesterId: number): void {
  if (!post.isPublic && post.userId !== requesterId) {
    throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  }
}

/**
 * assertPostVisible, and no block between the requester and the author. A
 * blocked pair's posts are gone from each other's feed, so opening one by id
 * — a stale link, an old notification — is the same 404 as a deleted post.
 * Taking back your own like is the one thing left open across a block; see
 * unlikePost.
 */
async function assertPostReachable(post: { isPublic: boolean; userId: number }, requesterId: number): Promise<void> {
  assertPostVisible(post, requesterId);
  // A blacklisted author's posts are gone for everyone, like a blocked pair's.
  if (await isHiddenFrom(requesterId, post.userId)) {
    throw Object.assign(new Error('Post not found'), { statusCode: 404 });
  }
}

// Looks up the primary (A01) contributor for a book, matching the pattern in
// recommendation-notifications.service.ts.
async function getPrimaryAuthor(bookId: number): Promise<string | null> {
  const [contributor] = await db
    .select({ personName: bookContributors.personName })
    .from(bookContributors)
    .where(and(eq(bookContributors.bookId, bookId), eq(bookContributors.role, 'A01')))
    .orderBy(bookContributors.sequenceNumber)
    .limit(1);
  return contributor?.personName ?? null;
}

// Notifies the post owner that someone liked their post. Never notifies on a
// self-like (caller is expected to check `post.userId !== userId` first).
// bookTitle, bookId, bookCoverUrl, likerName, and likerPhotoUrl are passed in
// from the caller to avoid extra DB fetches.
//
// Push and the in-app feed only — no email, deliberately. Likes and comments
// are high-frequency and low-consequence; mailing someone every time a post is
// liked is how an inbox learns to ignore us. The `likes` preference below gates
// the push, not an email, and there is no post-like email job to enqueue.
async function notifyPostLike(
  recipientId: number,
  likerId: number,
  postId: number,
  bookId: number,
  bookTitle: string,
  bookCoverUrl: string | null,
  likerName: string,
  likerPhotoUrl: string | null,
): Promise<void> {
  const enabled = await notificationPreferencesService.isEnabled(recipientId, 'likes');
  if (!enabled) return;

  const bookAuthor = await getPrimaryAuthor(bookId);

  await Promise.all([
    enqueuePush('post-like', {
      userId: recipientId,
      postId,
      likerName,
      bookTitle,
    }),
    db.insert(notifications).values({
      userId: recipientId,
      type: 'post_like',
      data: { postId, likerId, likerName, likerPhotoUrl, bookId, bookTitle, bookAuthor, bookCoverUrl },
    }),
  ]);
}

// Notifies the post owner that someone commented on their post. Never notifies
// on a self-comment (caller is expected to check `post.userId !== userId` first).
// The caller also checks the owner's `comments` preference: it needs the answer
// itself, to know whether this notification covers a mention of the owner.
// bookTitle, bookId, bookCoverUrl, commenterName, and commenterPhotoUrl are
// passed in from the caller to avoid extra DB fetches.
//
// Push and the in-app feed only — no email, for the same reason as
// notifyPostLike above.
async function notifyPostComment(
  recipientId: number,
  commenterId: number,
  postId: number,
  bookId: number,
  bookTitle: string,
  bookCoverUrl: string | null,
  commenterName: string,
  commenterPhotoUrl: string | null,
  commentId: number,
  commentBody: string,
): Promise<void> {
  const commentPreview =
    commentBody.length > COMMENT_PREVIEW_LENGTH
      ? `${commentBody.slice(0, COMMENT_PREVIEW_LENGTH)}…`
      : commentBody;

  const bookAuthor = await getPrimaryAuthor(bookId);

  await Promise.all([
    enqueuePush('post-comment', {
      userId: recipientId,
      postId,
      commentId,
      commenterName,
      bookTitle,
      commentPreview,
    }),
    db.insert(notifications).values({
      userId: recipientId,
      type: 'post_comment',
      data: {
        postId,
        commentId,
        commenterId,
        commenterName,
        commenterPhotoUrl,
        commentPreview,
        bookId,
        bookTitle,
        bookAuthor,
        bookCoverUrl,
      },
    }),
  ]);
}

// Batch-fetches like counts, comment counts, and the requester's own likes for a
// set of post IDs. Extracted to avoid copy-paste across list functions.
//
// Also renders each body's @mentions (see mentions.service), so every list that
// goes through here hands the client usernames rather than stored tokens.
export async function enrichPosts(
  rows: Omit<PostItem, 'mentions' | 'links' | 'isEdited'>[],
  requesterId: number,
): Promise<PostItem[]> {
  if (rows.length === 0) return [];

  const postIds = rows.map((r) => r.id);

  const [likeCounts, commentCounts, myLikes, rendered] = await Promise.all([
    db
      .select({ postId: postLikes.postId, count: sql<number>`COUNT(*)::int` })
      .from(postLikes)
      .where(inArray(postLikes.postId, postIds))
      .groupBy(postLikes.postId),
    // Counted as listComments shows them: without anyone blocked either way.
    db
      .select({ postId: comments.postId, count: sql<number>`COUNT(*)::int` })
      .from(comments)
      .where(and(inArray(comments.postId, postIds), commentVisibleTo(requesterId)))
      .groupBy(comments.postId),
    db
      .select({ postId: postLikes.postId })
      .from(postLikes)
      .where(and(inArray(postLikes.postId, postIds), eq(postLikes.userId, requesterId))),
    renderTexts(rows.map((r) => r.body)),
  ]);

  const likeMap = new Map(likeCounts.map((r) => [r.postId, r.count]));
  const commentMap = new Map(commentCounts.map((r) => [r.postId, r.count]));
  const likedSet = new Set(myLikes.map((r) => r.postId));

  return rows.map((r, i) =>
    withEditState({
      ...r,
      body: rendered[i].text,
      mentions: rendered[i].mentions,
      links: rendered[i].links,
      likeCount: likeMap.get(r.id) ?? 0,
      commentCount: commentMap.get(r.id) ?? 0,
      likedByMe: likedSet.has(r.id),
    }),
  );
}

const POST_SELECT_COLUMNS = {
  id: posts.id,
  userId: posts.userId,
  userName: users.name,
  userUsername: users.username,
  userPhotoUrl: users.photoUrl,
  bookId: posts.bookId,
  bookTitle: books.title,
  bookCoverUrl: books.coverUrl,
  bookIsbn13: books.isbn13,
  rating: posts.rating,
  status: posts.status,
  body: posts.body,
  isPublic: posts.isPublic,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,
  editedAt: posts.editedAt,
} as const;

// One page of posts matching `where`, with its total, excerpts, and the like
// and comment counts. Shared by the per-book lists, which differ only in which
// posts they show and in what order.
async function listPostPage(
  where: SQL | undefined,
  orderBy: SQL[],
  requesterId: number,
  limit: number,
  offset: number,
): Promise<{ posts: PostItem[]; total: number }> {
  const [rows, [countRow]] = await Promise.all([
    db
      .select(POST_SELECT_COLUMNS)
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)::int` }).from(posts).where(where),
  ]);

  const excerptMap = await getExcerptsByIsbns(rows.map((r) => r.bookIsbn13));

  const enriched = await enrichPosts(
    rows.map(({ bookIsbn13, ...r }) => ({
      ...r,
      bookExcerpt: pickExcerpt(bookIsbn13, excerptMap),
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
    })),
    requesterId,
  );

  return { posts: enriched, total: countRow?.count ?? 0 };
}

/**
 * How long an identical resubmission counts as the same post (a double tap or
 * a client retry) rather than a deliberate new one. Long enough to cover a
 * retry after a timeout; short enough that posting the same words about a
 * book days later is still allowed.
 */
const DUPLICATE_POST_WINDOW = '2 minutes';

// ── Service ───────────────────────────────────────────────────────────────────

export const communityService = {
  // ── Posts ──────────────────────────────────────────────────────────────────

  async createPost(userId: number, fields: CreatePostFields): Promise<{ id: number; duplicate: boolean }> {
    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, fields.bookId))
      .limit(1);

    if (!book) throw Object.assign(new Error('Book not found'), { statusCode: 404 });

    const body = await mentionsService.prepare(fields.body ?? null, userId, TEXT_LIMITS.post);
    const rating = fields.rating ?? null;

    // A reader may post about a book many times, but not the same post twice
    // in a row: a double tap or a retried request on a flaky connection would
    // otherwise put two identical posts in the feed. An identical post from the
    // last DUPLICATE_POST_WINDOW is handed back instead of inserting another.
    // The advisory lock (released at commit) serialises concurrent creates for
    // this reader and book, so two simultaneous submits cannot both miss the
    // check and both insert.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}::int, ${fields.bookId}::int)`);

      const [existing] = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(
          and(
            eq(posts.userId, userId),
            eq(posts.bookId, fields.bookId),
            eq(posts.status, fields.status),
            sql`${posts.rating} IS NOT DISTINCT FROM ${rating}`,
            sql`${posts.body} IS NOT DISTINCT FROM ${body.text}`,
            sql`${posts.createdAt} > now() - ${DUPLICATE_POST_WINDOW}::interval`,
          ),
        )
        .orderBy(desc(posts.createdAt))
        .limit(1);
      if (existing) return { id: existing.id, duplicate: true };

      const [row] = await tx
        .insert(posts)
        .values({
          userId,
          bookId: fields.bookId,
          rating,
          status: fields.status,
          body: body.text,
          isPublic: fields.isPublic,
        })
        .returning({ id: posts.id });
      return { id: row.id, duplicate: false };
    });

    if (!result.duplicate) {
      await mentionsService.afterWrite({ type: 'post', id: result.id }, userId, body.mentionedIds, { isNew: true });
    }

    return result;
  },

  async getPost(postId: number, requesterId: number): Promise<PostItem> {
    const [row] = await db
      .select(POST_SELECT_COLUMNS)
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(and(eq(posts.id, postId), isNull(posts.hiddenAt)))
      .limit(1);

    assertFound(row, 'Post');
    await assertPostReachable(row, requesterId);

    const { bookIsbn13, ...postFields } = row;

    const [[likeRow], [commentRow], likedRow, excerptMap, [rendered]] = await Promise.all([
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(postLikes)
        .where(eq(postLikes.postId, postId)),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(comments)
        .where(and(eq(comments.postId, postId), commentVisibleTo(requesterId))),
      db
        .select({ userId: postLikes.userId })
        .from(postLikes)
        .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, requesterId)))
        .limit(1),
      getExcerptsByIsbns([bookIsbn13]),
      renderTexts([postFields.body]),
    ]);

    return withEditState({
      ...postFields,
      body: rendered.text,
      mentions: rendered.mentions,
      links: rendered.links,
      bookExcerpt: pickExcerpt(bookIsbn13, excerptMap),
      likeCount: likeRow?.count ?? 0,
      commentCount: commentRow?.count ?? 0,
      likedByMe: likedRow.length > 0,
    });
  },

  async updatePost(
    postId: number,
    userId: number,
    fields: { rating?: number | null; status?: 'reading' | 'read'; body?: string | null; isPublic?: boolean },
  ): Promise<PostItem> {
    // The post as stored. Only the author's own post is found — anyone else
    // gets the 404 below, before any rule about its contents can leak.
    const [current] = await db
      .select({ rating: posts.rating, status: posts.status, body: posts.body })
      .from(posts)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId), isNull(posts.hiddenAt)))
      .limit(1);
    if (!current) throw Object.assign(new Error('Post not found'), { statusCode: 404 });

    // A `read` post must keep a rating, so check the post as it will be after
    // the patch: switching to `read` unrated, or clearing a `read` post's
    // rating, is refused.
    const nextStatus = fields.status ?? current.status;
    const nextRating = fields.rating !== undefined ? fields.rating : current.rating;
    if (nextStatus === 'read' && nextRating === null) {
      throw Object.assign(new Error('A rating is required when status is read'), { statusCode: 400 });
    }

    // A body that reads exactly as the author already sees it is left alone.
    // Compared as rendered text, not stored tokens: a handle that has started
    // (or stopped) naming an account since the post was written would
    // tokenise differently, and re-storing it would mark an untouched post
    // "Edited" and notify someone the author never chose to mention.
    //
    // Prepared only after the ownership check and only when the text really
    // changed: preparing stores short links, and a request that ends in a 404
    // or changes nothing must not write rows.
    let body: Awaited<ReturnType<typeof mentionsService.prepare<string | null>>> | undefined;
    if (fields.body !== undefined) {
      const [shown] = await renderTexts([current.body]);
      if (shown.text !== fields.body) body = await mentionsService.prepare(fields.body, userId, TEXT_LIMITS.post);
    }

    // What counts as an edit: a body, rating or status that differs from what
    // is stored. Visibility switches and resending the same values are not
    // edits, so the app does not mark a post "Edited" that reads as before.
    // Compared in SQL against the row being updated, so a concurrent edit
    // between the read above and this write is still judged correctly.
    const changed: SQL[] = [];
    if (fields.rating !== undefined) changed.push(sql`${posts.rating} IS DISTINCT FROM ${fields.rating}`);
    if (fields.status !== undefined) changed.push(sql`${posts.status} IS DISTINCT FROM ${fields.status}`);
    if (body !== undefined) changed.push(sql`${posts.body} IS DISTINCT FROM ${body.text}`);

    // Both timestamps from the database clock, in one statement, so editedAt
    // and updatedAt agree to the microsecond when an edit sets both.
    const updateSet: Record<string, unknown> = { updatedAt: sql`now()` };
    if (fields.rating !== undefined) updateSet.rating = fields.rating;
    if (fields.status !== undefined) updateSet.status = fields.status;
    if (body !== undefined) updateSet.body = body.text;
    if (fields.isPublic !== undefined) updateSet.isPublic = fields.isPublic;
    if (changed.length > 0) {
      updateSet.editedAt = sql`CASE WHEN ${sql.join(changed, sql` OR `)} THEN now() ELSE ${posts.editedAt} END`;
    }

    const result = await db
      .update(posts)
      .set(updateSet)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId), isNull(posts.hiddenAt)))
      .returning({ id: posts.id, isPublic: posts.isPublic });

    if (result.length === 0) {
      throw Object.assign(new Error('Post not found'), { statusCode: 404 });
    }

    if (body !== undefined) await mentionsService.afterWrite({ type: 'post', id: postId }, userId, body.mentionedIds);
    // A private post going public releases the mention notifications that were
    // held back while nobody else could read it — its own and its comments'.
    if (fields.isPublic === true && result[0].isPublic) await mentionsService.releaseUnderPost(postId);

    // The post as it now stands, so the app can show the edit (and its
    // "Edited" marker) without fetching it again.
    return communityService.getPost(postId, userId);
  },

  async deletePost(postId: number, userId: number): Promise<void> {
    const result = await db
      .delete(posts)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId), isNull(posts.hiddenAt)))
      .returning({ id: posts.id });

    if (result.length === 0) {
      throw Object.assign(new Error('Post not found'), { statusCode: 404 });
    }
  },

  async listPosts(
    requesterId: number,
    sort: 'date_asc' | 'date_desc',
    limit: number,
    offset: number,
  ): Promise<{ posts: PostItem[]; total: number }> {
    const where = and(eq(posts.isPublic, true), notBlockedBetween(requesterId, posts.userId), accountActive(posts.userId));
    const order = sort === 'date_asc' ? asc(posts.createdAt) : desc(posts.createdAt);

    const [rows, [countRow]] = await Promise.all([
      db
        .select(POST_SELECT_COLUMNS)
        .from(posts)
        .innerJoin(users, eq(users.id, posts.userId))
        .innerJoin(books, eq(books.id, posts.bookId))
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)::int` }).from(posts).where(where),
    ]);

    const excerptMap = await getExcerptsByIsbns(rows.map((r) => r.bookIsbn13));

    const enriched = await enrichPosts(
      rows.map(({ bookIsbn13, ...r }) => ({
        ...r,
        bookExcerpt: pickExcerpt(bookIsbn13, excerptMap),
        likeCount: 0,
        commentCount: 0,
        likedByMe: false,
      })),
      requesterId,
    );

    return { posts: enriched, total: countRow?.count ?? 0 };
  },

  async listOwnPosts(
    userId: number,
    sort: 'date_asc' | 'date_desc',
    limit: number,
    offset: number,
  ): Promise<{ posts: PostItem[]; total: number }> {
    // Not those a moderator hid: removed content is gone for its author too.
    const where = and(eq(posts.userId, userId), isNull(posts.hiddenAt));
    const order = sort === 'date_asc' ? asc(posts.createdAt) : desc(posts.createdAt);

    const [rows, [countRow]] = await Promise.all([
      db
        .select(POST_SELECT_COLUMNS)
        .from(posts)
        .innerJoin(users, eq(users.id, posts.userId))
        .innerJoin(books, eq(books.id, posts.bookId))
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)::int` }).from(posts).where(where),
    ]);

    const excerptMap = await getExcerptsByIsbns(rows.map((r) => r.bookIsbn13));

    const enriched = await enrichPosts(
      rows.map(({ bookIsbn13, ...r }) => ({
        ...r,
        bookExcerpt: pickExcerpt(bookIsbn13, excerptMap),
        likeCount: 0,
        commentCount: 0,
        likedByMe: false,
      })),
      userId,
    );

    return { posts: enriched, total: countRow?.count ?? 0 };
  },

  async listPostsForBook(
    bookId: number,
    requesterId: number,
    sort: 'date_asc' | 'date_desc',
    limit: number,
    offset: number,
  ): Promise<{ posts: PostItem[]; total: number }> {
    const order = sort === 'date_asc' ? asc(posts.createdAt) : desc(posts.createdAt);
    return listPostPage(
      and(eq(posts.bookId, bookId), eq(posts.isPublic, true), notBlockedBetween(requesterId, posts.userId), accountActive(posts.userId)),
      [order],
      requesterId,
      limit,
      offset,
    );
  },

  /**
   * Everyone's reviews of one book, with the requester's own pinned first.
   *
   * Differs from listPostsForBook in two ways: the requester's own reviews are
   * included even when private (they are theirs being shown back to them —
   * nobody else's private review ever appears), and they always sort ahead of
   * everyone else's, whatever `sort` asks for. Each item carries `isMine`.
   *
   * A reader can post about a book more than once, so "own reviews" may be
   * several posts; they are pinned as a block, ordered among themselves by
   * `sort`, and a long run of them can carry past page one. The pin is part of
   * the ORDER BY, not prepended after the fact, so offset pagination stays
   * consistent: each post appears exactly once across pages and once in
   * `total`.
   *
   * Matched on the exact book id, like myReview — see my-reviews.service.
   * Throws a 404 for a book that does not exist.
   */
  async listReviewsForBook(
    bookId: number,
    requesterId: number,
    sort: 'date_asc' | 'date_desc',
    limit: number,
    offset: number,
  ): Promise<{ posts: (PostItem & { isMine: boolean })[]; total: number }> {
    const where = and(
      eq(posts.bookId, bookId),
      or(eq(posts.isPublic, true), eq(posts.userId, requesterId)),
      // Hidden by a moderator: gone for its author too, who would otherwise
      // still find it here as one of their own private posts.
      isNull(posts.hiddenAt),
      notBlockedBetween(requesterId, posts.userId),
      accountActive(posts.userId),
    );
    const byDate = sort === 'date_asc' ? asc(posts.createdAt) : desc(posts.createdAt);
    // The id tiebreak keeps pages stable when two reviews share a timestamp.
    const byId = sort === 'date_asc' ? asc(posts.id) : desc(posts.id);

    // The existence check runs alongside the page rather than ahead of it: an
    // unknown book has no posts, so the page is empty and cheap either way.
    const [[book], page] = await Promise.all([
      db.select({ id: books.id }).from(books).where(eq(books.id, bookId)).limit(1),
      listPostPage(where, [desc(sql`${posts.userId} = ${requesterId}`), byDate, byId], requesterId, limit, offset),
    ]);
    assertFound(book, 'Book');

    return {
      posts: page.posts.map((p) => ({ ...p, isMine: p.userId === requesterId })),
      total: page.total,
    };
  },

  // ── Post likes ─────────────────────────────────────────────────────────────

  async likePost(postId: number, userId: number): Promise<void> {
    const [[post], [actor]] = await Promise.all([
      db
        .select({
          isPublic: posts.isPublic,
          userId: posts.userId,
          bookId: posts.bookId,
          bookTitle: books.title,
          bookCoverUrl: books.coverUrl,
        })
        .from(posts)
        .innerJoin(books, eq(books.id, posts.bookId))
        .where(and(eq(posts.id, postId), isNull(posts.hiddenAt)))
        .limit(1),
      db.select({ name: users.name, photoUrl: users.photoUrl }).from(users).where(eq(users.id, userId)).limit(1),
    ]);

    assertFound(post, 'Post');
    await assertPostReachable(post, userId);

    const [inserted] = await db
      .insert(postLikes)
      .values({ userId, postId })
      .onConflictDoNothing()
      .returning({ userId: postLikes.userId });

    // Only notify on a genuinely new like — onConflictDoNothing no-ops on a
    // repeat like — and never notify the post owner about their own like.
    if (inserted && post.userId !== userId && actor) {
      notifyPostLike(
        post.userId,
        userId,
        postId,
        post.bookId,
        post.bookTitle,
        post.bookCoverUrl,
        actor.name,
        actor.photoUrl,
      ).catch((err) => logger.error('Failed to dispatch post-like notification', { err, postId }));
    }
  },

  async unlikePost(postId: number, userId: number): Promise<void> {
    const [post] = await db
      .select({ isPublic: posts.isPublic, userId: posts.userId })
      .from(posts)
      .where(and(eq(posts.id, postId), isNull(posts.hiddenAt)))
      .limit(1);

    assertFound(post, 'Post');
    assertPostVisible(post, userId);

    await db
      .delete(postLikes)
      .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, userId)));
  },

  // ── Comments ───────────────────────────────────────────────────────────────

  async addComment(postId: number, userId: number, body: string): Promise<{ id: number }> {
    const [[post], [actor]] = await Promise.all([
      db
        .select({
          isPublic: posts.isPublic,
          userId: posts.userId,
          bookId: posts.bookId,
          bookTitle: books.title,
          bookCoverUrl: books.coverUrl,
        })
        .from(posts)
        .innerJoin(books, eq(books.id, posts.bookId))
        .where(and(eq(posts.id, postId), isNull(posts.hiddenAt)))
        .limit(1),
      db.select({ name: users.name, photoUrl: users.photoUrl }).from(users).where(eq(users.id, userId)).limit(1),
    ]);

    assertFound(post, 'Post');
    await assertPostReachable(post, userId);

    const prepared = await mentionsService.prepare(body, userId, TEXT_LIMITS.comment);
    const [row] = await db
      .insert(comments)
      .values({ postId, userId, body: prepared.text })
      .returning({ id: comments.id });

    // Never notify the post owner about their own comment.
    const notifyOwner =
      post.userId !== userId && !!actor && (await notificationPreferencesService.isEnabled(post.userId, 'comments'));

    // An owner who is being sent "new comment on your post" for these words is
    // not also sent "you were mentioned" for them. Only here, on the comment's
    // creation: an edit sends no comment notification, so a mention it adds
    // reaches the owner as a mention like anyone else's.
    await mentionsService.afterWrite({ type: 'comment', id: row.id }, userId, prepared.mentionedIds, {
      isNew: true,
      alreadyNotifiedIds: notifyOwner ? [post.userId] : [],
    });

    if (notifyOwner && actor) {
      // The preview reads as the comment does in the app: short links, not the
      // addresses as typed, so blocking a link also covers the notification.
      const [shown] = await renderTexts([prepared.text]);
      notifyPostComment(
        post.userId,
        userId,
        postId,
        post.bookId,
        post.bookTitle,
        post.bookCoverUrl,
        actor.name,
        actor.photoUrl,
        row.id,
        shown.text ?? body,
      ).catch((err) => logger.error('Failed to dispatch post-comment notification', { err, postId }));
    }

    return { id: row.id };
  },

  async updateComment(
    commentId: number,
    userId: number,
    body: string,
  ): Promise<Pick<CommentItem, 'id' | 'body' | 'mentions' | 'links' | 'updatedAt' | 'isEdited' | 'editedAt'>> {
    const [current] = await db
      .select({ body: comments.body, updatedAt: comments.updatedAt, editedAt: comments.editedAt })
      .from(comments)
      .where(and(eq(comments.id, commentId), eq(comments.userId, userId), isNull(comments.hiddenAt)))
      .limit(1);
    if (!current) throw Object.assign(new Error('Comment not found'), { statusCode: 404 });

    // Text that reads exactly as it already does is not an edit and is not
    // re-stored — compared as rendered text for the reason given in updatePost.
    const [shown] = await renderTexts([current.body]);
    if (shown.text === body) {
      return withEditState({
        id: commentId,
        body: shown.text ?? '',
        mentions: shown.mentions,
        links: shown.links,
        updatedAt: current.updatedAt,
        editedAt: current.editedAt,
      });
    }

    // Prepared only now, after the ownership check and the unchanged check:
    // preparing stores short links, which a refused or no-op edit must not.
    const prepared = await mentionsService.prepare(body, userId, TEXT_LIMITS.comment);

    // The CASE still guards against a concurrent edit having already stored
    // this same text; both timestamps come from the database clock.
    const [row] = await db
      .update(comments)
      .set({
        body: prepared.text,
        updatedAt: sql`now()`,
        editedAt: sql`CASE WHEN ${comments.body} IS DISTINCT FROM ${prepared.text} THEN now() ELSE ${comments.editedAt} END`,
      })
      .where(and(eq(comments.id, commentId), eq(comments.userId, userId), isNull(comments.hiddenAt)))
      .returning({ id: comments.id, body: comments.body, updatedAt: comments.updatedAt, editedAt: comments.editedAt });

    if (!row) {
      throw Object.assign(new Error('Comment not found'), { statusCode: 404 });
    }

    await mentionsService.afterWrite({ type: 'comment', id: commentId }, userId, prepared.mentionedIds);

    const [rendered] = await renderTexts([row.body]);
    return withEditState({
      id: row.id,
      body: rendered.text ?? '',
      mentions: rendered.mentions,
      links: rendered.links,
      updatedAt: row.updatedAt,
      editedAt: row.editedAt,
    });
  },

  async deleteComment(commentId: number, userId: number): Promise<void> {
    const result = await db
      .delete(comments)
      .where(and(eq(comments.id, commentId), eq(comments.userId, userId), isNull(comments.hiddenAt)))
      .returning({ id: comments.id });

    if (result.length === 0) {
      throw Object.assign(new Error('Comment not found'), { statusCode: 404 });
    }
  },

  async listComments(
    postId: number,
    requesterId: number,
    limit: number,
    offset: number,
  ): Promise<{ comments: CommentItem[]; total: number }> {
    const [post] = await db
      .select({ isPublic: posts.isPublic, userId: posts.userId })
      .from(posts)
      .where(and(eq(posts.id, postId), isNull(posts.hiddenAt)))
      .limit(1);

    assertFound(post, 'Post');
    await assertPostReachable(post, requesterId);

    // A blocked pair's comments are hidden from each other, old ones included —
    // on either one's post, and on anyone else's. So is a comment a moderator
    // has hidden, from everyone but its author.
    const where = and(eq(comments.postId, postId), commentVisibleTo(requesterId));

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: comments.id,
          postId: comments.postId,
          userId: comments.userId,
          userName: users.name,
          userUsername: users.username,
          userPhotoUrl: users.photoUrl,
          body: comments.body,
          createdAt: comments.createdAt,
          updatedAt: comments.updatedAt,
          editedAt: comments.editedAt,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.userId))
        .where(where)
        .orderBy(desc(comments.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`COUNT(*)::int` }).from(comments).where(where),
    ]);

    if (rows.length === 0) return { comments: [], total: countRow?.count ?? 0 };

    const commentIds = rows.map((r) => r.id);

    const [likeCounts, myLikes, rendered] = await Promise.all([
      db
        .select({ commentId: commentLikes.commentId, count: sql<number>`COUNT(*)::int` })
        .from(commentLikes)
        .where(inArray(commentLikes.commentId, commentIds))
        .groupBy(commentLikes.commentId),
      db
        .select({ commentId: commentLikes.commentId })
        .from(commentLikes)
        .where(and(inArray(commentLikes.commentId, commentIds), eq(commentLikes.userId, requesterId))),
      renderTexts(rows.map((r) => r.body)),
    ]);

    const likeMap = new Map(likeCounts.map((r) => [r.commentId, r.count]));
    const likedSet = new Set(myLikes.map((r) => r.commentId));

    return {
      comments: rows.map((r, i) => ({
        ...r,
        body: rendered[i].text ?? '',
        mentions: rendered[i].mentions,
        links: rendered[i].links,
        likeCount: likeMap.get(r.id) ?? 0,
        likedByMe: likedSet.has(r.id),
      })).map(withEditState),
      total: countRow?.count ?? 0,
    };
  },

  // ── Comment likes ──────────────────────────────────────────────────────────

  async likeComment(commentId: number, userId: number): Promise<void> {
    const [row] = await db
      .select({ isPublic: posts.isPublic, postUserId: posts.userId, commentUserId: comments.userId })
      .from(comments)
      .innerJoin(posts, eq(posts.id, comments.postId))
      .where(and(eq(comments.id, commentId), isNull(comments.hiddenAt), isNull(posts.hiddenAt)))
      .limit(1);

    assertFound(row, 'Comment');
    await assertPostReachable({ isPublic: row.isPublic, userId: row.postUserId }, userId);
    // A comment hidden from you by a block, or by its author's blacklist, is not there to like.
    if (await isHiddenFrom(userId, row.commentUserId)) {
      throw Object.assign(new Error('Comment not found'), { statusCode: 404 });
    }

    await db
      .insert(commentLikes)
      .values({ userId, commentId })
      .onConflictDoNothing();
  },

  async unlikeComment(commentId: number, userId: number): Promise<void> {
    const [row] = await db
      .select({ isPublic: posts.isPublic, postUserId: posts.userId })
      .from(comments)
      .innerJoin(posts, eq(posts.id, comments.postId))
      .where(and(eq(comments.id, commentId), isNull(comments.hiddenAt), isNull(posts.hiddenAt)))
      .limit(1);

    assertFound(row, 'Comment');
    assertPostVisible({ isPublic: row.isPublic, userId: row.postUserId }, userId);

    await db
      .delete(commentLikes)
      .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, userId)));
  },

  // ── Friend book detail ─────────────────────────────────────────────────────

  async getFriendBookDetail(
    friendId: number,
    bookId: number,
    requesterId: number,
  ): Promise<FriendBookDetail> {
    // Accepted followers always see one book; everyone else follows the shelf setting
    await assertCanViewShelf(friendId, requesterId, canViewShelfBook);

    const [[bookRow], [postRow], [userBookRow]] = await Promise.all([
      db
        .select({
          id: books.id,
          title: books.title,
          coverUrl: books.coverUrl,
          isbn13: books.isbn13,
        })
        .from(books)
        .where(eq(books.id, bookId))
        .limit(1),

      db
        .select({
          rating: posts.rating,
          body: posts.body,
          editedAt: posts.editedAt,
        })
        .from(posts)
        .where(
          and(
            eq(posts.userId, friendId),
            eq(posts.bookId, bookId),
            // A private review is author-only everywhere (see assertPostVisible),
            // and a public shelf must not become a way round that
            or(eq(posts.isPublic, true), eq(posts.userId, requesterId)),
            isNull(posts.hiddenAt),
            // Nor a block: someone who blocked them can still open their shelf,
            // but posts never cross a block, so the book shows with no review.
            notBlockedBetween(requesterId, posts.userId),
          ),
        )
        // They may have posted about this book more than once (while reading,
        // then when finished). Their latest post is the review shown — rating,
        // text and edit state all from that one post, so the page never pairs
        // an old rating with newer words. Like myReview.
        .orderBy(desc(posts.createdAt), desc(posts.id))
        .limit(1),

      db
        .select({
          note: userBooks.note,
          noteIsPublic: userBooks.noteIsPublic,
          friendName: users.name,
          friendUsername: users.username,
          friendPhotoUrl: users.photoUrl,
        })
        .from(userBooks)
        .innerJoin(users, eq(users.id, userBooks.userId))
        .where(and(eq(userBooks.userId, friendId), eq(userBooks.bookId, bookId)))
        .limit(1),
    ]);

    assertFound(bookRow, 'Book');
    assertFound(userBookRow, 'User book');

    const note = userBookRow.noteIsPublic ? (userBookRow.note ?? null) : null;
    const [contributorRows, excerptMap, [review, renderedNote]] = await Promise.all([
      db
        .select({ personName: bookContributors.personName, role: bookContributors.role })
        .from(bookContributors)
        .where(eq(bookContributors.bookId, bookId))
        .orderBy(bookContributors.sequenceNumber),
      getExcerptsByIsbns([bookRow.isbn13]),
      renderTexts([postRow?.body ?? null, note]),
    ]);

    return {
      bookId: bookRow.id,
      bookTitle: bookRow.title,
      bookCoverUrl: bookRow.coverUrl,
      bookExcerpt: pickExcerpt(bookRow.isbn13, excerptMap),
      contributors: contributorRows,
      friendName: userBookRow.friendName,
      friendUsername: userBookRow.friendUsername,
      friendPhotoUrl: userBookRow.friendPhotoUrl,
      rating: postRow?.rating ?? null,
      review: review.text,
      reviewMentions: review.mentions,
      reviewLinks: review.links,
      reviewIsEdited: isEdited(postRow?.editedAt),
      reviewEditedAt: postRow?.editedAt ?? null,
      note: renderedNote.text,
      noteMentions: renderedNote.mentions,
      noteLinks: renderedNote.links,
    };
  },
};
