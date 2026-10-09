import { and, asc, eq, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { users, groups, groupMemberships, posts, comments, groupBooks, groupBookComments } from '../db/schema';
import { friendOfCondition } from './groups.service';
import { escapeLike } from '../lib/escape-like';

export interface MentionSuggestion {
  id: number;
  username: string;
  name: string;
  photoUrl: string | null;
}

/**
 * What the person is typing in, so the people already in that conversation can
 * be ranked first. Anything the caller cannot see is ignored rather than
 * refused: the typeahead should never fail, and it must never reveal who is in
 * a private group by ranking its members.
 */
export type SuggestionContext =
  | { type: 'post'; id: number }
  | { type: 'group'; id: number }
  | { type: 'group_book'; id: number };

export const SUGGESTION_LIMIT = 10;

/**
 * The people in the conversation `context` points at, as a condition on
 * users.id — or null when there is no context, or the caller may not see it.
 */
async function participantCondition(viewerId: number, context: SuggestionContext | undefined): Promise<SQL | null> {
  if (!context) return null;

  if (context.type === 'post') {
    const [post] = await db
      .select({ isPublic: posts.isPublic, userId: posts.userId })
      .from(posts)
      .where(eq(posts.id, context.id))
      .limit(1);
    if (!post || (!post.isPublic && post.userId !== viewerId)) return null;
    return sql`${users.id} IN (
      SELECT ${posts.userId} FROM ${posts} WHERE ${posts.id} = ${context.id}
      UNION
      SELECT ${comments.userId} FROM ${comments} WHERE ${comments.postId} = ${context.id}
    )`;
  }

  // A shelf entry's conversation is its group's members, plus anyone who has
  // commented on it (a former member of a public group may have).
  let groupId = context.id;
  if (context.type === 'group_book') {
    const [entry] = await db
      .select({ groupId: groupBooks.groupId })
      .from(groupBooks)
      .where(eq(groupBooks.id, context.id))
      .limit(1);
    if (!entry) return null;
    groupId = entry.groupId;
  }

  // Same line as the member list: anyone for a public group, members only for
  // a private one (see groupViewerCapabilities.canSeeMembers).
  const [standing] = await db
    .select({ privacy: groups.privacy, status: groupMemberships.status })
    .from(groups)
    .leftJoin(groupMemberships, and(eq(groupMemberships.groupId, groups.id), eq(groupMemberships.userId, viewerId)))
    .where(eq(groups.id, groupId))
    .limit(1);
  if (!standing || (standing.privacy !== 'public' && standing.status !== 'active')) return null;

  const members = sql`SELECT ${groupMemberships.userId} FROM ${groupMemberships}
    WHERE ${groupMemberships.groupId} = ${groupId} AND ${groupMemberships.status} = 'active'`;
  if (context.type !== 'group_book') return sql`${users.id} IN (${members})`;
  return sql`${users.id} IN (
    ${members}
    UNION
    SELECT ${groupBookComments.userId} FROM ${groupBookComments} WHERE ${groupBookComments.groupBookId} = ${context.id}
  )`;
}

export const mentionSuggestionsService = {
  /**
   * The list under the cursor after `@`.
   *
   * Anyone with a username can be mentioned, so anyone can be suggested — but
   * ranked so the person you mean is near the top: people already in this
   * conversation, then your friends, then everyone else; within each, a
   * username that starts with what you typed before a display name that does.
   *
   * With nothing typed yet (just `@`) the list is the conversation and your
   * friends only. Strangers ranked alphabetically are not a suggestion.
   *
   * Excludes you, guests (they have no username) and blacklisted accounts.
   */
  async suggest(viewerId: number, rawQuery: string, context?: SuggestionContext): Promise<MentionSuggestion[]> {
    const q = rawQuery.trim().replace(/^@/, '').toLowerCase();
    const participants = await participantCondition(viewerId, context);
    const friends = friendOfCondition(viewerId);

    const base = and(
      isNotNull(users.username),
      ne(users.id, viewerId),
      isNull(users.blacklistedAt),
    );

    let match: SQL | undefined;
    let usernamePrefix: SQL = sql`false`;
    if (q) {
      const prefix = `${escapeLike(q)}%`;
      usernamePrefix = sql`${users.username} LIKE ${prefix}`;
      match = or(
        usernamePrefix,
        sql`${users.name} ILIKE ${prefix}`,
        sql`${users.name} ILIKE ${`% ${escapeLike(q)}%`}`,
      );
    } else {
      match = participants ? or(participants, friends) : friends;
    }

    const rows = await db
      .select({ id: users.id, username: users.username, name: users.name, photoUrl: users.photoUrl })
      .from(users)
      .where(and(base, match))
      .orderBy(
        ...(participants ? [sql`CASE WHEN ${participants} THEN 0 ELSE 1 END`] : []),
        sql`CASE WHEN ${friends} THEN 0 ELSE 1 END`,
        sql`CASE WHEN ${usernamePrefix} THEN 0 ELSE 1 END`,
        asc(users.username),
      )
      .limit(SUGGESTION_LIMIT);

    return rows.map((r) => ({ ...r, username: r.username! }));
  },
};
