import { eq, and, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db';
import { alias } from 'drizzle-orm/pg-core';
import { users, posts, books, postLikes, comments, groups, followRequests } from '../db/schema';
import { buildGroupSearchCondition, buildGroupSearchOrderBy, groupNotBlacklisted } from './groups.service';
import { enrichPosts } from './community.service';
import type { PostItem } from './community.service';
import { getExcerptsByIsbns, pickExcerpt } from './book-excerpts.service';
import { withRenderedMentions } from './mentions.service';
import { likePrefix, likeWordPrefix } from '../lib/escape-like';
import { plainTsQuery } from '../lib/tsquery';
import { toFollowStatus, type FollowStatus } from './users.service';
import { accountActive, blockedByViewer, notBlockedBetween, notBlockedViewer } from './blocks.service';
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
  // 'blocked' when the requester has blocked them, as on the profile.
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
  return likePrefix(handle.toLowerCase());
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

  const prefix = likePrefix(q);
  const wordPrefix = likeWordPrefix(q);
  const fts = q.length >= 3
    ? sql` OR ${users.searchVector} @@ ${plainTsQuery('simple', q)}`
    : sql``;

  // Usernames match by prefix alongside the name, so "amareads" finds
  // @ama_reads' owner even though their display name is "Ama Owusu".
  return sql`(
    ${users.name} ILIKE ${prefix}
    OR ${users.name} ILIKE ${wordPrefix}
    OR ${users.username} LIKE ${usernameLikePrefix(q)}
    OR word_similarity(${q}, ${users.name}) > 0.5
    ${fts}
  )`;
}

function buildUserSearchOrderBy(q: string): SQL[] {
  if (usernamePrefixOf(q) !== null) return [sql`length(${users.username})`, sql`${users.username}`];

  const prefix = likePrefix(q);
  const wordPrefix = likeWordPrefix(q);

  return [
    sql`CASE
      WHEN ${users.name} ILIKE ${prefix}     THEN 0
      WHEN ${users.name} ILIKE ${wordPrefix} THEN 1
      WHEN word_similarity(${q}, ${users.name}) > 0.5 THEN 2
      ELSE 3
    END`,
    sql`word_similarity(${q}, ${users.name}) DESC`,
    sql`ts_rank(${users.searchVector}, ${plainTsQuery('simple', q)}) DESC`,
  ];
}

// Straight, curly and low double quotes — what phone keyboards type.
const QUOTED = /["\u201C\u201D\u201E]([^"\u201C\u201D\u201E]*)["\u201C\u201D\u201E]/g;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * `q` as a tsquery over posts.search_vector, or null when it has no words.
 *
 * Built from plainto_tsquery and phraseto_tsquery rather than
 * websearch_to_tsquery: websearch reads a leading `-` as NOT and `or` as OR,
 * so "-gripping" matched every post without the word. Here each quoted part
 * must appear as that phrase and the rest are plain words, in any order — all
 * stemmed, so "reading" finds "read". Every part goes through
 * post_search_text(), the function the stored column is built with
 * (drizzle/0085), so the two sides are cleaned identically.
 */
function postWordsQuery(q: string): SQL | null {
  const phrases = [...q.matchAll(QUOTED)].map((m) => m[1]).filter((p) => HAS_WORD.test(p));
  const loose = q.replace(QUOTED, ' ');
  const parts = [
    ...(HAS_WORD.test(loose) ? [sql`plainto_tsquery('english', post_search_text(${loose}))`] : []),
    ...phrases.map((p) => sql`phraseto_tsquery('english', post_search_text(${p}))`),
  ];
  return parts.length > 0 ? sql`(${sql.join(parts, sql` && `)})` : null;
}

/**
 * Whether `column` (posts.search_text) contains `q` as written, part words
 * included ("gripp"). The query is cleaned by the same post_search_text() as
 * the column, so curly and straight apostrophes match each other, and the
 * cleaning leaves no LIKE metacharacters to escape. Needs three characters
 * once cleaned — one or two letters are in nearly every post, and the trigram
 * index can't serve them.
 */
function postWordingMatch(column: SQLWrapper, q: string): SQL {
  const cleaned = sql`post_search_text(${q})`;
  return sql`(char_length(${cleaned}) >= 3 AND ${column} LIKE ('%' || ${cleaned} || '%'))`;
}

// The posts and books tables again, for the two match subqueries below
const textMatch = alias(posts, 'text_match');
const titleMatch = alias(books, 'title_match');

/**
 * Posts whose book title matches `q` — as before — or whose own text does:
 * as words and quoted phrases (postWordsQuery), or as the exact wording
 * (postWordingMatch). Both text tests read the stored columns, where @mention
 * and link tokens are already blanked out.
 *
 * Each side is an `IN (subquery)` rather than ORs over the joined row. An OR
 * mixing books and posts columns can use neither table's indexes, so every
 * search ran the trigram LIKE, the tsquery and word_similarity once per public
 * post. Instead:
 *  - text: a subquery over posts alone ORs the two GIN indexes (a BitmapOr);
 *  - title: tested once per book that has posts, not once per post — a book
 *    with forty posts was having its title compared forty times.
 * The outer query then only checks membership in the two id sets.
 */
export function buildPostSearchCondition(q: string): SQL {
  const prefix = likePrefix(q);
  const wordPrefix = likeWordPrefix(q);
  const words = postWordsQuery(q);
  const bookFts = q.length >= 3
    ? sql` OR ${titleMatch.searchVector} @@ ${plainTsQuery('english', q)}`
    : sql``;
  const textWords = words !== null ? sql` OR ${textMatch.searchVector} @@ ${words}` : sql``;

  const titleMatches = db
    .select({ id: titleMatch.id })
    .from(titleMatch)
    .where(and(
      inArray(titleMatch.id, db.selectDistinct({ id: posts.bookId }).from(posts)),
      sql`(
        ${titleMatch.title} ILIKE ${prefix}
        OR ${titleMatch.title} ILIKE ${wordPrefix}
        OR word_similarity(${q}, ${titleMatch.title}) > 0.5
        ${bookFts}
      )`,
    ));
  const textMatches = db
    .select({ id: textMatch.id })
    .from(textMatch)
    .where(sql`${postWordingMatch(textMatch.searchText, q)} ${textWords}`);

  return sql`(${inArray(posts.bookId, titleMatches)} OR ${inArray(posts.id, textMatches)})`;
}

/**
 * Ranks the matches from `buildPostSearchCondition`: the book's title first,
 * as before, then posts that say exactly what was typed, then posts that use
 * the words, then fuzzy title matches.
 *
 * Within a tier, the tie-break fits what put the post there: closeness of the
 * post text for the two text tiers, title similarity for the title tiers —
 * the order title matches always had, which group and people search share.
 * Then the newest post, with the id last so offset pages never overlap.
 */
function buildPostSearchOrderBy(q: string): SQL[] {
  const prefix = likePrefix(q);
  const wordPrefix = likeWordPrefix(q);
  const words = postWordsQuery(q);
  const bodyWordsTier = words !== null ? sql`WHEN ${posts.searchVector} @@ ${words} THEN 3` : sql``;
  const tier = sql`CASE
      WHEN ${books.title} ILIKE ${prefix}     THEN 0
      WHEN ${books.title} ILIKE ${wordPrefix} THEN 1
      WHEN ${postWordingMatch(posts.searchText, q)} THEN 2
      ${bodyWordsTier}
      WHEN word_similarity(${q}, ${books.title}) > 0.5 THEN 4
      ELSE 5
    END`;
  const titleCloseness = sql`word_similarity(${q}, ${books.title})`;
  const withinTier = words !== null
    ? sql`CASE WHEN ${tier} IN (2, 3) THEN ts_rank_cd(${posts.searchVector}, ${words}) ELSE ${titleCloseness} END`
    : titleCloseness;

  return [
    tier,
    sql`${withinTier} DESC`,
    sql`ts_rank(${books.searchVector}, ${plainTsQuery('english', q)}) DESC`,
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
  // Someone who blocked you doesn't turn up. Someone you blocked does, marked
  // `blocked`, so you can find them again to unblock.
  const where = and(buildUserSearchCondition(q), notBlockedViewer(requesterId, users.id), isNull(users.blacklistedAt));
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
        blockedByMe: blockedByViewer(requesterId, users.id).mapWith(Boolean),
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

  const results = rows.map(({ outgoingStatus, incomingRequestId, incomingRequestedAt, blockedByMe, ...user }) => ({
    ...user,
    // 'blocked' as on the profile: the row's button reads Blocked, not Follow.
    followStatus:
      user.id === requesterId ? ('self' as const) : blockedByMe ? ('blocked' as const) : toFollowStatus(outgoingStatus),
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
  const where = and(eq(posts.isPublic, true), buildPostSearchCondition(q), notBlockedBetween(requesterId, posts.userId), accountActive(posts.userId));
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
  const where = and(groupNotBlacklisted, buildGroupSearchCondition(q));

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
