import { eq, and, asc, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db';
import { posts, postLikes, comments, commentLikes, users, books, userBooks, bookContributors, followRequests } from '../db/schema';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreatePostFields {
  bookId: number;
  rating: number;
  status: 'reading' | 'read';
  body?: string;
  isPublic: boolean;
}

export interface PostItem {
  id: number;
  userId: number;
  userName: string;
  userPhotoUrl: string | null;
  bookId: number;
  bookTitle: string;
  bookCoverUrl: string | null;
  rating: number;
  status: 'reading' | 'read';
  body: string | null;
  isPublic: boolean;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FriendBookDetail {
  bookId: number;
  bookTitle: string;
  bookCoverUrl: string | null;
  contributors: { personName: string | null; role: string | null }[];
  friendName: string;
  friendPhotoUrl: string | null;
  rating: number | null;
  review: string | null;
  note: string | null;
}

export interface CommentItem {
  id: number;
  postId: number;
  userId: number;
  userName: string;
  userPhotoUrl: string | null;
  body: string;
  likeCount: number;
  likedByMe: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Batch-fetches like counts, comment counts, and the requester's own likes for a
// set of post IDs. Extracted to avoid copy-paste across list functions.
export async function enrichPosts(
  rows: PostItem[],
  requesterId: number,
): Promise<PostItem[]> {
  if (rows.length === 0) return rows;

  const postIds = rows.map((r) => r.id);

  const [likeCounts, commentCounts, myLikes] = await Promise.all([
    db
      .select({ postId: postLikes.postId, count: sql<number>`COUNT(*)::int` })
      .from(postLikes)
      .where(inArray(postLikes.postId, postIds))
      .groupBy(postLikes.postId),
    db
      .select({ postId: comments.postId, count: sql<number>`COUNT(*)::int` })
      .from(comments)
      .where(inArray(comments.postId, postIds))
      .groupBy(comments.postId),
    db
      .select({ postId: postLikes.postId })
      .from(postLikes)
      .where(and(inArray(postLikes.postId, postIds), eq(postLikes.userId, requesterId))),
  ]);

  const likeMap = new Map(likeCounts.map((r) => [r.postId, r.count]));
  const commentMap = new Map(commentCounts.map((r) => [r.postId, r.count]));
  const likedSet = new Set(myLikes.map((r) => r.postId));

  return rows.map((r) => ({
    ...r,
    likeCount: likeMap.get(r.id) ?? 0,
    commentCount: commentMap.get(r.id) ?? 0,
    likedByMe: likedSet.has(r.id),
  }));
}

const POST_SELECT_COLUMNS = {
  id: posts.id,
  userId: posts.userId,
  userName: users.name,
  userPhotoUrl: users.photoUrl,
  bookId: posts.bookId,
  bookTitle: books.title,
  bookCoverUrl: books.coverUrl,
  rating: posts.rating,
  status: posts.status,
  body: posts.body,
  isPublic: posts.isPublic,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,
} as const;

// ── Service ───────────────────────────────────────────────────────────────────

export const communityService = {
  // ── Posts ──────────────────────────────────────────────────────────────────

  async createPost(userId: number, fields: CreatePostFields): Promise<{ id: number }> {
    const [book] = await db
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, fields.bookId))
      .limit(1);

    if (!book) throw Object.assign(new Error('Book not found'), { statusCode: 404 });

    const [row] = await db
      .insert(posts)
      .values({
        userId,
        bookId: fields.bookId,
        rating: fields.rating,
        status: fields.status,
        body: fields.body ?? null,
        isPublic: fields.isPublic,
      })
      .onConflictDoNothing()
      .returning({ id: posts.id });

    if (!row) {
      throw Object.assign(new Error('You have already posted about this book'), { statusCode: 409 });
    }

    return { id: row.id };
  },

  async getPost(postId: number, requesterId: number): Promise<PostItem> {
    const [row] = await db
      .select(POST_SELECT_COLUMNS)
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(eq(posts.id, postId))
      .limit(1);

    assertFound(row, 'Post');
    assertPostVisible(row, requesterId);

    const [[likeRow], [commentRow], likedRow] = await Promise.all([
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(postLikes)
        .where(eq(postLikes.postId, postId)),
      db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(comments)
        .where(eq(comments.postId, postId)),
      db
        .select({ userId: postLikes.userId })
        .from(postLikes)
        .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, requesterId)))
        .limit(1),
    ]);

    return {
      ...row,
      likeCount: likeRow?.count ?? 0,
      commentCount: commentRow?.count ?? 0,
      likedByMe: likedRow.length > 0,
    };
  },

  async updatePost(
    postId: number,
    userId: number,
    fields: { rating?: number; status?: 'reading' | 'read'; body?: string | null; isPublic?: boolean },
  ): Promise<void> {
    const updateSet: Record<string, unknown> = { updatedAt: new Date() };
    if (fields.rating !== undefined) updateSet.rating = fields.rating;
    if (fields.status !== undefined) updateSet.status = fields.status;
    if (fields.body !== undefined) updateSet.body = fields.body;
    if (fields.isPublic !== undefined) updateSet.isPublic = fields.isPublic;

    const result = await db
      .update(posts)
      .set(updateSet)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
      .returning({ id: posts.id });

    if (result.length === 0) {
      throw Object.assign(new Error('Post not found'), { statusCode: 404 });
    }
  },

  async deletePost(postId: number, userId: number): Promise<void> {
    const result = await db
      .delete(posts)
      .where(and(eq(posts.id, postId), eq(posts.userId, userId)))
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
    const where = eq(posts.isPublic, true);
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

    const enriched = await enrichPosts(
      rows.map((r) => ({ ...r, likeCount: 0, commentCount: 0, likedByMe: false })),
      requesterId,
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
    const where = and(eq(posts.bookId, bookId), eq(posts.isPublic, true));
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

    const enriched = await enrichPosts(
      rows.map((r) => ({ ...r, likeCount: 0, commentCount: 0, likedByMe: false })),
      requesterId,
    );

    return { posts: enriched, total: countRow?.count ?? 0 };
  },

  // ── Post likes ─────────────────────────────────────────────────────────────

  async likePost(postId: number, userId: number): Promise<void> {
    const [post] = await db
      .select({ isPublic: posts.isPublic, userId: posts.userId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    assertFound(post, 'Post');
    assertPostVisible(post, userId);

    await db
      .insert(postLikes)
      .values({ userId, postId })
      .onConflictDoNothing();
  },

  async unlikePost(postId: number, userId: number): Promise<void> {
    const [post] = await db
      .select({ isPublic: posts.isPublic, userId: posts.userId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    assertFound(post, 'Post');
    assertPostVisible(post, userId);

    await db
      .delete(postLikes)
      .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, userId)));
  },

  // ── Comments ───────────────────────────────────────────────────────────────

  async addComment(postId: number, userId: number, body: string): Promise<{ id: number }> {
    const [post] = await db
      .select({ isPublic: posts.isPublic, userId: posts.userId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);

    assertFound(post, 'Post');
    assertPostVisible(post, userId);

    const [row] = await db
      .insert(comments)
      .values({ postId, userId, body })
      .returning({ id: comments.id });

    return { id: row.id };
  },

  async updateComment(commentId: number, userId: number, body: string): Promise<void> {
    const result = await db
      .update(comments)
      .set({ body, updatedAt: new Date() })
      .where(and(eq(comments.id, commentId), eq(comments.userId, userId)))
      .returning({ id: comments.id });

    if (result.length === 0) {
      throw Object.assign(new Error('Comment not found'), { statusCode: 404 });
    }
  },

  async deleteComment(commentId: number, userId: number): Promise<void> {
    const result = await db
      .delete(comments)
      .where(and(eq(comments.id, commentId), eq(comments.userId, userId)))
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
      .where(eq(posts.id, postId))
      .limit(1);

    assertFound(post, 'Post');
    assertPostVisible(post, requesterId);

    const where = eq(comments.postId, postId);

    const [rows, [countRow]] = await Promise.all([
      db
        .select({
          id: comments.id,
          postId: comments.postId,
          userId: comments.userId,
          userName: users.name,
          userPhotoUrl: users.photoUrl,
          body: comments.body,
          createdAt: comments.createdAt,
          updatedAt: comments.updatedAt,
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

    const [likeCounts, myLikes] = await Promise.all([
      db
        .select({ commentId: commentLikes.commentId, count: sql<number>`COUNT(*)::int` })
        .from(commentLikes)
        .where(inArray(commentLikes.commentId, commentIds))
        .groupBy(commentLikes.commentId),
      db
        .select({ commentId: commentLikes.commentId })
        .from(commentLikes)
        .where(and(inArray(commentLikes.commentId, commentIds), eq(commentLikes.userId, requesterId))),
    ]);

    const likeMap = new Map(likeCounts.map((r) => [r.commentId, r.count]));
    const likedSet = new Set(myLikes.map((r) => r.commentId));

    return {
      comments: rows.map((r) => ({
        ...r,
        likeCount: likeMap.get(r.id) ?? 0,
        likedByMe: likedSet.has(r.id),
      })),
      total: countRow?.count ?? 0,
    };
  },

  // ── Comment likes ──────────────────────────────────────────────────────────

  async likeComment(commentId: number, userId: number): Promise<void> {
    const [row] = await db
      .select({ isPublic: posts.isPublic, postUserId: posts.userId })
      .from(comments)
      .innerJoin(posts, eq(posts.id, comments.postId))
      .where(eq(comments.id, commentId))
      .limit(1);

    assertFound(row, 'Comment');
    assertPostVisible({ isPublic: row.isPublic, userId: row.postUserId }, userId);

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
      .where(eq(comments.id, commentId))
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
    // Verify the requester is an accepted follower before exposing friend data
    const [followRow] = await db
      .select({ id: followRequests.id })
      .from(followRequests)
      .where(
        and(
          eq(followRequests.senderId, requesterId),
          eq(followRequests.receiverId, friendId),
          eq(followRequests.status, 'accepted'),
        ),
      )
      .limit(1);

    if (!followRow) {
      throw Object.assign(new Error('User not found'), { statusCode: 404 });
    }

    const [[bookRow], [postRow], [userBookRow]] = await Promise.all([
      db
        .select({
          id: books.id,
          title: books.title,
          coverUrl: books.coverUrl,
        })
        .from(books)
        .where(eq(books.id, bookId))
        .limit(1),

      db
        .select({
          rating: posts.rating,
          body: posts.body,
        })
        .from(posts)
        .where(and(eq(posts.userId, friendId), eq(posts.bookId, bookId)))
        .limit(1),

      db
        .select({
          note: userBooks.note,
          noteIsPublic: userBooks.noteIsPublic,
          friendName: users.name,
          friendPhotoUrl: users.photoUrl,
        })
        .from(userBooks)
        .innerJoin(users, eq(users.id, userBooks.userId))
        .where(and(eq(userBooks.userId, friendId), eq(userBooks.bookId, bookId)))
        .limit(1),
    ]);

    assertFound(bookRow, 'Book');
    assertFound(userBookRow, 'User book');

    const contributorRows = await db
      .select({ personName: bookContributors.personName, role: bookContributors.role })
      .from(bookContributors)
      .where(eq(bookContributors.bookId, bookId))
      .orderBy(bookContributors.sequenceNumber);

    return {
      bookId: bookRow.id,
      bookTitle: bookRow.title,
      bookCoverUrl: bookRow.coverUrl,
      contributors: contributorRows,
      friendName: userBookRow.friendName,
      friendPhotoUrl: userBookRow.friendPhotoUrl,
      rating: postRow?.rating ?? null,
      review: postRow?.body ?? null,
      note: userBookRow.noteIsPublic ? (userBookRow.note ?? null) : null,
    };
  },
};
