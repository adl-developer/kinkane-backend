import { eq, and, desc, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db';
import { alias } from 'drizzle-orm/pg-core';
import { users, posts, books, postLikes, comments, groups, followRequests } from '../db/schema';
import { buildGroupSearchCondition, buildGroupSearchOrderBy, groupNotBlacklisted } from './groups.service';
import { commentVisibleTo, enrichPosts } from './community.service';
import type { PostItem } from './community.service';
import { getExcerptsByIsbns, pickExcerpt } from './book-excerpts.service';
import { renderTexts, withRenderedMentions } from './mentions.service';
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

/** The comment that put a post in the results, when nothing in the post itself did. */
export interface MatchedComment {
  id: number;
  userId: number;
  userName: string;
  userUsername: string | null;
  userPhotoUrl: string | null;
  body: string;
  mentions: MentionRef[];
  links: LinkRef[];
  createdAt: Date;
}

export interface PostSearchResult extends PostItem {
  /**
   * Set only when the post matched on a comment alone, so the app can show why
   * it is there; null when its book title or its own text matched.
   */
  matchedComment: MatchedComment | null;
}

export interface SearchResult {
  users: UserResult[];
  posts: PostSearchResult[];
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
 * A book's title and subtitle as a tsvector. Not books.search_vector: that also
 * holds the ISBN and the long description, so a post matched whenever its
 * book's blurb mentioned the word. Built per row rather than indexed, which is
 * fine here — the title subquery only visits books that have posts.
 */
function bookTitleWords(book: { title: SQLWrapper; subtitle: SQLWrapper }): SQL {
  return sql`to_tsvector('english', coalesce(${book.title}, '') || ' ' || coalesce(${book.subtitle}, ''))`;
}

/**
 * Whether stored text says `q`, as the exact wording (postWordingMatch) or as
 * words and quoted phrases (postWordsQuery). Posts and comments both keep the
 * two columns this reads (drizzle/0084, 0092), so one test serves both and the
 * two can never match the same query differently.
 */
function textSays(column: { searchText: SQLWrapper; searchVector: SQLWrapper }, q: string): SQL {
  const words = postWordsQuery(q);
  const byWords = words !== null ? sql` OR ${column.searchVector} @@ ${words}` : sql``;
  return sql`(${postWordingMatch(column.searchText, q)} ${byWords})`;
}

// The post a comment is under, for the comment subquery below
const commentPost = alias(posts, 'comment_post');

/**
 * Posts with a comment `requesterId` can see that matches `q`, one row each,
 * as a derived table for searchPosts to LEFT JOIN. Only the comments the
 * post's thread would show them count: none hidden by a moderator, none across
 * a block, none by a blacklisted account — otherwise a post would turn up for
 * a reason the searcher cannot find on it. Comments on private posts are
 * skipped before the per-comment block checks run, since those posts never
 * reach the results anyway.
 *
 * A join rather than `IN (subquery)`: the filter and the tier both need to know
 * whether a post has a hit, and an IN repeated in each is planned as a separate
 * scan of every matching comment per mention.
 */
export function postsWithMatchingComment(q: string, requesterId: number) {
  return db
    .selectDistinct({ postId: comments.postId })
    .from(comments)
    .innerJoin(commentPost, and(eq(commentPost.id, comments.postId), eq(commentPost.isPublic, true)))
    .where(and(textSays(comments, q), commentVisibleTo(requesterId)))
    .as('comment_hits');
}

/** True for a post the `postsWithMatchingComment` join found a comment for. */
type CommentHit = SQL;

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
 *  - comments: `postsWithMatchingComment`, joined in by the caller, which
 *    passes whether this row has a hit as `commentHit`.
 * The outer query then only checks membership in the two id sets, or the hit.
 */
export function buildPostSearchCondition(q: string, commentHit: CommentHit): SQL {
  const prefix = likePrefix(q);
  const wordPrefix = likeWordPrefix(q);
  const bookFts = q.length >= 3
    ? sql` OR ${bookTitleWords(titleMatch)} @@ ${plainTsQuery('english', q)}`
    : sql``;

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
    .where(textSays(textMatch, q));

  return sql`(
    ${inArray(posts.bookId, titleMatches)}
    OR ${inArray(posts.id, textMatches)}
    OR ${commentHit}
  )`;
}

/** Tiers 0–5 are the post and its book; a post in COMMENT_TIER matched on a comment alone. */
const COMMENT_TIER = 6;

/**
 * Which rung of the ranking ladder put a post in the results. One WHEN per arm
 * of `buildPostSearchCondition`, title arms before comments, so a post that
 * matched on anything of its own never lands in COMMENT_TIER.
 */
function buildPostSearchTier(q: string, commentHit: CommentHit): SQL {
  const prefix = likePrefix(q);
  const wordPrefix = likeWordPrefix(q);
  const words = postWordsQuery(q);
  const bodyWordsTier = words !== null ? sql`WHEN ${posts.searchVector} @@ ${words} THEN 3` : sql``;
  const titleWordsTier = q.length >= 3
    ? sql`WHEN ${bookTitleWords(books)} @@ ${plainTsQuery('english', q)} THEN 5`
    : sql``;
  return sql`CASE
      WHEN ${books.title} ILIKE ${prefix}     THEN 0
      WHEN ${books.title} ILIKE ${wordPrefix} THEN 1
      WHEN ${postWordingMatch(posts.searchText, q)} THEN 2
      ${bodyWordsTier}
      WHEN word_similarity(${q}, ${books.title}) > 0.5 THEN 4
      ${titleWordsTier}
      WHEN ${commentHit} THEN ${sql.raw(String(COMMENT_TIER))}
      ELSE 7
    END`;
}

/**
 * Ranks the matches from `buildPostSearchCondition`: the book's title first,
 * as before, then posts that say exactly what was typed, then posts that use
 * the words, then fuzzy title matches, then the title's words in any order,
 * and last posts that matched only on a comment — what someone else said under
 * a post is weaker evidence that the post is about `q` than anything in the
 * post itself.
 *
 * Within a tier, the tie-break fits what put the post there: closeness of the
 * post text for the two text tiers, title similarity for the title tiers —
 * the order title matches always had, which group and people search share.
 * Comment-only matches have no closeness of their own and fall to the newest
 * post. Then the newest post, with the id last so offset pages never overlap.
 */
function buildPostSearchOrderBy(q: string, tier: SQL): SQL[] {
  const words = postWordsQuery(q);
  const textRank = words !== null ? sql`ts_rank_cd(${posts.searchVector}, ${words})` : sql`0`;
  return [
    tier,
    sql`CASE WHEN ${tier} IN (2, 3) THEN ${textRank}
             WHEN ${tier} = ${sql.raw(String(COMMENT_TIER))} THEN 0
             ELSE word_similarity(${q}, ${books.title}) END DESC`,
    sql`ts_rank(${bookTitleWords(books)}, ${plainTsQuery('english', q)}) DESC`,
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
): Promise<{ results: PostSearchResult[]; total: number }> {
  const commentHits = postsWithMatchingComment(q, requesterId);
  const commentHit = sql`${commentHits.postId} IS NOT NULL`;
  const where = and(eq(posts.isPublic, true), buildPostSearchCondition(q, commentHit), notBlockedBetween(requesterId, posts.userId), accountActive(posts.userId));
  const tier = buildPostSearchTier(q, commentHit);

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
        tier: sql<number>`${tier}`.mapWith(Number),
      })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .leftJoin(commentHits, eq(commentHits.postId, posts.id))
      .where(where)
      .orderBy(...buildPostSearchOrderBy(q, tier))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(posts)
      .innerJoin(users, eq(users.id, posts.userId))
      .innerJoin(books, eq(books.id, posts.bookId))
      .leftJoin(commentHits, eq(commentHits.postId, posts.id))
      .where(where),
  ]);

  const commentOnly = rows.filter((r) => r.tier === COMMENT_TIER).map((r) => r.id);
  const [excerptMap, matched] = await Promise.all([
    getExcerptsByIsbns(rows.map((r) => r.bookIsbn13)),
    matchingComments(q, requesterId, commentOnly),
  ]);

  const enriched = await enrichPosts(
    rows.map(({ bookIsbn13, tier: _tier, ...r }) => ({
      ...r,
      bookExcerpt: pickExcerpt(bookIsbn13, excerptMap),
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
    })),
    requesterId,
  );

  return {
    results: enriched.map((p) => ({ ...p, matchedComment: matched.get(p.id) ?? null })),
    total: countRow?.count ?? 0,
  };
}

/**
 * For each of `postIds`, the visible comment that best matches `q`: the
 * closest by word rank, then the newest. One query for the page, not one per
 * post. Bodies are rendered (handles, short links) the way the comment thread
 * shows them.
 */
async function matchingComments(
  q: string,
  requesterId: number,
  postIds: number[],
): Promise<Map<number, MatchedComment>> {
  if (postIds.length === 0) return new Map();
  const words = postWordsQuery(q);
  const closeness = words !== null ? sql`ts_rank_cd(${comments.searchVector}, ${words})` : sql`0`;

  const rows = await db
    .selectDistinctOn([comments.postId], {
      postId: comments.postId,
      id: comments.id,
      userId: comments.userId,
      userName: users.name,
      userUsername: users.username,
      userPhotoUrl: users.photoUrl,
      body: comments.body,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(and(inArray(comments.postId, postIds), commentVisibleTo(requesterId), textSays(comments, q)))
    .orderBy(comments.postId, sql`${closeness} DESC`, desc(comments.createdAt), desc(comments.id));

  const rendered = await renderTexts(rows.map((r) => r.body));
  return new Map(rows.map(({ postId, ...r }, i) => [
    postId,
    { ...r, body: rendered[i].text ?? '', mentions: rendered[i].mentions, links: rendered[i].links },
  ]));
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
