import { eq, and, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { alias } from 'drizzle-orm/pg-core';
import { users, posts, books, postLikes, comments, groups, followRequests } from '../db/schema';
import { buildGroupSearchCondition, buildGroupSearchOrderBy } from './groups.service';
import { enrichPosts } from './community.service';
import type { PostItem } from './community.service';
import { getExcerptsByIsbns, pickExcerpt } from './book-excerpts.service';
import { withRenderedMentions } from './mentions.service';
import { escapeLike } from '../lib/escape-like';
import { toFollowStatus, type FollowStatus } from './users.service';
import type { MentionRef } from '../lib/mention-text';
import type { LinkRef } from '../lib/link-text';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserResult {
  id: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
  // The requester's follow request to this user, as on the profile, plus
  // 'self' for the requester's own row so the app can leave off the button.
  followStatus: FollowStatus | 'self';
  // A pending request *they* sent the requester, for Accept/Decline, as on the
  // profile. It doesn't stop the requester following them back.
  incomingFollowRequest: { requestId: number; requestedAt: Date } | null;
}

export type SearchFilter = 'all' | 'users' | 'posts' | 'groups';

/** A group as the Community "Groups" tab and the Explore toggle draw it. */
export interface GroupResult {
  id: number;
  name: string;
  description: string | null;
  /** Linked @handles in `description`. */
  descriptionMentions: MentionRef[];
  descriptionLinks: LinkRef[];
  photoUrl: string | null;
  privacy: 'public' | 'private';
  memberCount: number;
}

export interface SearchResult {
  users: UserResult[];
  posts: PostItem[];
  groups: GroupResult[];
  total: { users: number; posts: number; groups: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A handle as a LIKE prefix — lowercased, as usernames are stored, and escaped (`_` is a username character). */
function usernameLikePrefix(handle: string): string {
  return escapeLike(handle.toLowerCase()) + '%';
}

/**
 * A query starting with `@` is a username search and matches usernames only —
 * someone typing `@am` is looking for a handle, not for everyone called Amy.
 * Returns the prefix to match on, or null for an ordinary search.
 */
function usernamePrefixOf(q: string): string | null {
  return q.startsWith('@') ? usernameLikePrefix(q.slice(1)) : null;
}

function buildUserSearchCondition(q: string): SQL {
  const handlePrefix = usernamePrefixOf(q);
  if (handlePrefix !== null) return sql`${users.username} LIKE ${handlePrefix}`;

  const prefix = q + '%';
  const wordPrefix = '% ' + q + '%';
  const fts = q.length >= 3
    ? sql` OR ${users.searchVector} @@ plainto_tsquery('simple', ${q})`
    : sql``;

  // Usernames match by prefix alongside the name, so "amareads" finds
  // @ama_reads' owner even though their display name is "Ama Owusu".
  return sql`(
    ${users.name} ILIKE ${prefix}
    OR ${users.name} ILIKE ${wordPrefix}
    OR ${users.username} LIKE ${usernameLikePrefix(q)}
    OR word_similarity(${q}, ${users.name}) > 0.3
    ${fts}
  )`;
}

function buildUserSearchOrderBy(q: string): SQL[] {
  if (usernamePrefixOf(q) !== null) return [sql`length(${users.username})`, sql`${users.username}`];

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

/**
 * What a post search matches the post's own text against. Lowercased here as
 * posts.search_text/search_vector are lowercased in drizzle/0084 — under ICU
 * there, and JavaScript's Unicode-aware toLowerCase() here, because the
 * database's ctype C would leave "É" alone.
 *
 * `wording` is the query as literal text, for the "contains these exact words"
 * tier: straight or curly double quotes are dropped, so a quoted phrase is still
 * found as typed. Null under three characters — a one- or two-letter substring
 * is in nearly every post, and the trigram index can't serve it anyway.
 */
function postTextTerms(q: string): { words: string; wording: string | null } {
  const words = q.toLowerCase();
  const literal = words.replace(/["\u201C\u201D]/g, '').trim();
  return { words, wording: literal.length >= 3 ? '%' + escapeLike(literal) + '%' : null };
}

/**
 * Posts whose book title matches `q` — as before — or whose own text does.
 *
 * The text is matched two ways: as words, with websearch_to_tsquery so
 * `"slow burn"` in quotes must appear as that phrase while unquoted words may
 * appear anywhere (stemmed, so "reading" finds "read"); and as literal wording,
 * which also finds part of a word ("gripp"). Both run on the stored columns,
 * with @mention and link tokens already blanked out.
 */
function buildPostSearchCondition(q: string): SQL {
  const prefix = escapeLike(q) + '%';
  const wordPrefix = '% ' + escapeLike(q) + '%';
  const { words, wording } = postTextTerms(q);
  const bookFts = q.length >= 3
    ? sql` OR ${books.searchVector} @@ plainto_tsquery('english', ${q})`
    : sql``;
  const bodyWording = wording !== null ? sql` OR ${posts.searchText} LIKE ${wording}` : sql``;

  return sql`(
    ${books.title} ILIKE ${prefix}
    OR ${books.title} ILIKE ${wordPrefix}
    ${bodyWording}
    OR ${posts.searchVector} @@ websearch_to_tsquery('english', ${words})
    OR word_similarity(${q}, ${books.title}) > 0.3
    ${bookFts}
  )`;
}

/**
 * Ranks the matches from `buildPostSearchCondition`, one CASE branch per tier
 * there and in the same order: the book's title first, as before, then posts
 * that say exactly what was typed, then posts that use the words, then fuzzy
 * title matches. Ties go to the closest text match, then the newest post — the
 * id last so offset pages never overlap.
 */
function buildPostSearchOrderBy(q: string): SQL[] {
  const prefix = escapeLike(q) + '%';
  const wordPrefix = '% ' + escapeLike(q) + '%';
  const { words, wording } = postTextTerms(q);
  const bodyWordingTier = wording !== null ? sql`WHEN ${posts.searchText} LIKE ${wording} THEN 2` : sql``;

  return [
    sql`CASE
      WHEN ${books.title} ILIKE ${prefix}     THEN 0
      WHEN ${books.title} ILIKE ${wordPrefix} THEN 1
      ${bodyWordingTier}
      WHEN ${posts.searchVector} @@ websearch_to_tsquery('english', ${words}) THEN 3
      WHEN word_similarity(${q}, ${books.title}) > 0.3 THEN 4
      ELSE 5
    END`,
    sql`ts_rank_cd(${posts.searchVector}, websearch_to_tsquery('english', ${words})) DESC`,
    sql`word_similarity(${q}, ${books.title}) DESC`,
    sql`ts_rank(${books.searchVector}, plainto_tsquery('english', ${q})) DESC`,
    sql`${posts.createdAt} DESC`,
    sql`${posts.id} DESC`,
  ];
}

// ── Service ───────────────────────────────────────────────────────────────────

// Both directions of the follow graph between the requester and each result
const outgoing = alias(followRequests, 'outgoing');
const incoming = alias(followRequests, 'incoming');

async function searchUsers(
  q: string,
  requesterId: number,
  limit: number,
  offset: number,
): Promise<{ results: UserResult[]; total: number }> {
  const where = buildUserSearchCondition(q);
  const orderBy = buildUserSearchOrderBy(q);

  const [rows, [countRow]] = await Promise.all([
    // sender/receiver is unique, so each join adds at most one row per user
    db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        photoUrl: users.photoUrl,
        outgoingStatus: outgoing.status,
        incomingRequestId: incoming.id,
        incomingRequestedAt: incoming.createdAt,
      })
      .from(users)
      .leftJoin(outgoing, and(eq(outgoing.senderId, requesterId), eq(outgoing.receiverId, users.id)))
      .leftJoin(
        incoming,
        and(eq(incoming.senderId, users.id), eq(incoming.receiverId, requesterId), eq(incoming.status, 'pending')),
      )
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)::int` }).from(users).where(where),
  ]);

  const results = rows.map(({ outgoingStatus, incomingRequestId, incomingRequestedAt, ...user }) => ({
    ...user,
    followStatus: user.id === requesterId ? ('self' as const) : toFollowStatus(outgoingStatus),
    incomingFollowRequest:
      incomingRequestId !== null && incomingRequestedAt !== null
        ? { requestId: incomingRequestId, requestedAt: incomingRequestedAt }
        : null,
  }));
  return { results, total: countRow?.count ?? 0 };
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

  return { results: enriched, total: countRow?.count ?? 0 };
}

/**
 * Groups matching `q`, using the same four-tier formula as users and posts.
 *
 * The builders live in groups.service.ts rather than here: they are also used by
 * GET /groups?q, and one definition is what keeps the Community tab and the
 * Explore toggle ranking identically.
 *
 * Private groups are included on purpose — they are unjoinable, not secret, and
 * hiding them would make the "you need an invite" screen unreachable for anyone
 * who had not already been sent a link.
 */
async function searchGroups(
  q: string,
  limit: number,
  offset: number,
): Promise<{ results: GroupResult[]; total: number }> {
  const where = buildGroupSearchCondition(q);

  const [results, [counted]] = await Promise.all([
    db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        photoUrl: groups.photoUrl,
        privacy: groups.privacy,
        memberCount: groups.memberCount,
      })
      .from(groups)
      .where(where)
      .orderBy(...buildGroupSearchOrderBy(q))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(groups).where(where),
  ]);

  return { results: await withRenderedMentions(results, 'description', 'descriptionMentions', 'descriptionLinks'), total: counted?.count ?? 0 };
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
    const includeGroups = filter === 'all' || filter === 'groups';

    // Joined into the existing Promise.all rather than awaited after it, so
    // filter='all' costs one more parallel query rather than a serial hop.
    const [userResults, postResults, groupResults] = await Promise.all([
      includeUsers ? searchUsers(q, requesterId, limit, offset) : Promise.resolve({ results: [], total: 0 }),
      includePosts ? searchPosts(q, requesterId, limit, offset) : Promise.resolve({ results: [], total: 0 }),
      includeGroups ? searchGroups(q, limit, offset) : Promise.resolve({ results: [], total: 0 }),
    ]);

    return {
      users: userResults.results,
      posts: postResults.results,
      groups: groupResults.results,
      total: { users: userResults.total, posts: postResults.total, groups: groupResults.total },
    };
  },
};
