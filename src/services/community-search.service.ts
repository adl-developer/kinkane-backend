import { eq, and, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { users, posts, books, postLikes, comments } from '../db/schema';
import { enrichPosts } from './community.service';
import type { PostItem } from './community.service';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserResult {
  id: number;
  name: string;
  photoUrl: string | null;
}

export type SearchFilter = 'all' | 'users' | 'posts';

export interface SearchResult {
  users: UserResult[];
  posts: PostItem[];
  total: { users: number; posts: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUserSearchCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  const fts = q.length >= 3
    ? sql` OR ${users.searchVector} @@ plainto_tsquery('simple', ${q})`
    : sql``;

  return sql`(
    ${users.name} ILIKE ${prefix}
    OR ${users.name} ILIKE ${wordPrefix}
    OR word_similarity(${q}, ${users.name}) > 0.3
    ${fts}
  )`;
}

function buildUserSearchOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  return [
    sql`CASE
      WHEN ${users.name} ILIKE ${prefix}     THEN 0
      WHEN ${users.name} ILIKE ${wordPrefix} THEN 1
      WHEN word_similarity(${q}, ${users.name}) > 0.3 THEN 2
      ELSE 3
    END`,
    sql`word_similarity(${q}, ${users.name}) DESC`,
    sql`ts_rank(${users.searchVector}, plainto_tsquery('simple', ${q})) DESC`,
  ];
}

function buildPostSearchCondition(q: string): SQL {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  const fts = q.length >= 3
    ? sql` OR ${books.searchVector} @@ plainto_tsquery('english', ${q})`
    : sql``;

  return sql`(
    ${books.title} ILIKE ${prefix}
    OR ${books.title} ILIKE ${wordPrefix}
    OR word_similarity(${q}, ${books.title}) > 0.3
    ${fts}
  )`;
}

function buildPostSearchOrderBy(q: string): SQL[] {
  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';

  return [
    sql`CASE
      WHEN ${books.title} ILIKE ${prefix}     THEN 0
      WHEN ${books.title} ILIKE ${wordPrefix} THEN 1
      WHEN word_similarity(${q}, ${books.title}) > 0.3 THEN 2
      ELSE 3
    END`,
    sql`word_similarity(${q}, ${books.title}) DESC`,
    sql`ts_rank(${books.searchVector}, plainto_tsquery('english', ${q})) DESC`,
  ];
}

// ── Service ───────────────────────────────────────────────────────────────────

async function searchUsers(q: string, limit: number, offset: number): Promise<{ results: UserResult[]; total: number }> {
  const where = buildUserSearchCondition(q);
  const orderBy = buildUserSearchOrderBy(q);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, photoUrl: users.photoUrl })
      .from(users)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)::int` }).from(users).where(where),
  ]);

  return { results: rows, total: countRow?.count ?? 0 };
}

async function searchPosts(
  q: string,
  requesterId: number,
  limit: number,
  offset: number,
): Promise<{ results: PostItem[]; total: number }> {
  const where = and(eq(posts.isPublic, true), buildPostSearchCondition(q));
  const orderBy = buildPostSearchOrderBy(q);

  const [rows, [countRow]] = await Promise.all([
    db
      .select({
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
      })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .where(where),
  ]);

  const enriched = await enrichPosts(
    rows.map((r) => ({ ...r, likeCount: 0, commentCount: 0, likedByMe: false })),
    requesterId,
  );

  return { results: enriched, total: countRow?.count ?? 0 };
}

export const communitySearchService = {
  async search(
    q: string,
    filter: SearchFilter,
    requesterId: number,
    limit: number,
    offset: number,
  ): Promise<SearchResult> {
    const includeUsers = filter === 'all' || filter === 'users';
    const includePosts = filter === 'all' || filter === 'posts';

    const [userResults, postResults] = await Promise.all([
      includeUsers ? searchUsers(q, limit, offset) : Promise.resolve({ results: [], total: 0 }),
      includePosts ? searchPosts(q, requesterId, limit, offset) : Promise.resolve({ results: [], total: 0 }),
    ]);

    return {
      users: userResults.results,
      posts: postResults.results,
      total: { users: userResults.total, posts: postResults.total },
    };
  },
};
