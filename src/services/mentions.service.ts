import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  mentions,
  users,
  posts,
  comments,
  books,
  groups,
  groupMemberships,
  groupBooks,
  groupBookComments,
  userBooks,
  notifications,
  notificationPreferences,
  type GroupPrivacy,
} from '../db/schema';
import {
  MAX_MENTIONS_PER_TEXT,
  extractHandles,
  hasTokens,
  render,
  tokenIds,
  tokenize,
  type MentionRef,
} from '../lib/mention-text';
import { enqueuePush } from '../lib/push-queue';
import { logger } from '../lib/logger';

/**
 * Mentions, end to end: turning typed `@handles` into stored tokens, keeping
 * the `mentions` table in step with the text, telling people they were
 * mentioned, and rendering tokens back into usernames on every read.
 *
 * The rules for the text itself live in lib/mention-text.ts; this is the part
 * that needs the database.
 *
 * WHO GETS TOLD, AND WHEN. Anyone can be mentioned anywhere, but a mention is
 * only worth a notification if the person can go and read it. Three outcomes,
 * decided per person (see `decide`):
 *
 *  - full: they can see the text. Notified with an excerpt.
 *  - restricted: the text is in a private group they are not in. Notified that
 *    they were mentioned and where, but with no excerpt — the group's name is
 *    public, its discussion is not, and a notification must not be a way to
 *    read a private group from outside it.
 *  - deferred: the text is private to its author (a private post, a comment
 *    under one, a private shelf note). Nothing is sent and the row stays owed;
 *    if the author later makes it public, `dispatch` runs again and the owed
 *    notifications go out then.
 */

export type MentionSourceType = 'post' | 'comment' | 'group' | 'group_book' | 'group_comment' | 'book_note';

/** A piece of text that can contain mentions, by what it is and its row id. */
export interface MentionSource {
  type: MentionSourceType;
  /** posts.id, comments.id, groups.id, group_books.id, group_book_comments.id or user_books.id. */
  id: number;
}

/** Where a mention lives, as the client needs it to navigate there. Only the keys that apply are set. */
export interface MentionTarget {
  postId?: number;
  commentId?: number;
  groupId?: number;
  groupName?: string;
  groupBookId?: number;
  groupCommentId?: number;
  /** For a reply in a group discussion, the comment it replies to; null for a top-level comment. */
  parentCommentId?: number | null;
  bookId?: number;
  bookTitle?: string;
}

export interface MentionPerson {
  id: number;
  name: string;
  username: string | null;
  photoUrl: string | null;
}

/** One item in GET /user/mentions. */
export interface MentionFeedItem {
  id: number;
  sourceType: MentionSourceType;
  createdAt: Date;
  /** Who mentioned you. Null if their account has since been deleted. */
  author: MentionPerson | null;
  /**
   * The start of the text you were mentioned in, rendered. Null when you can no
   * longer see it — it is in a private group you are not in, or its author has
   * since made it private.
   */
  excerpt: string | null;
  /** Linked handles within `excerpt`. */
  mentions: MentionRef[];
  /** True when `excerpt` is withheld. */
  restricted: boolean;
  target: MentionTarget;
}

type Decision = 'full' | 'restricted' | 'deferred';

type Audience =
  | { kind: 'everyone' }
  /** Visible only to `ownerId` — a private post, a comment under one, a private note. */
  | { kind: 'owner'; ownerId: number }
  | { kind: 'group'; groupId: number; privacy: GroupPrivacy };

interface SourceContext {
  /** The stored text, tokens and all. */
  text: string | null;
  audience: Audience;
  target: MentionTarget;
}

/** Options for a write's mention handling. */
export interface AfterWriteOptions {
  /**
   * The text was created by this write, not edited. A new text with no
   * mentions has no rows to reconcile, so nothing is queried at all.
   */
  isNew?: boolean;
  /**
   * People already told about this exact write some other way, who should not
   * also get a mention notification for it — the post owner who was just sent
   * "new comment on your post" for these words. Only ever passed for the write
   * that sent that other notification: an edit sends no "new comment", so a
   * mention added by an edit is notified normally.
   */
  alreadyNotifiedIds?: number[];
}

const EXCERPT_LENGTH = 140;

/**
 * Each kind of source, as the `mentions` table stores it: the FK column, and
 * the key that column has in an insert and in a selected row. The one place
 * this mapping lives; everything below derives from it.
 */
const SOURCES = {
  post: { column: mentions.postId, field: 'postId' },
  comment: { column: mentions.commentId, field: 'commentId' },
  group: { column: mentions.groupId, field: 'groupId' },
  group_book: { column: mentions.groupBookId, field: 'groupBookId' },
  group_comment: { column: mentions.groupCommentId, field: 'groupCommentId' },
  book_note: { column: mentions.userBookId, field: 'userBookId' },
} as const satisfies Record<MentionSourceType, { column: unknown; field: keyof typeof mentions.$inferSelect }>;

type SourceField = (typeof SOURCES)[MentionSourceType]['field'];

const SOURCE_ENTRIES = Object.entries(SOURCES) as [MentionSourceType, (typeof SOURCES)[MentionSourceType]][];

/** Every source column, keyed by its field, for a select that needs to know which one is set. */
const SOURCE_COLUMNS = Object.fromEntries(SOURCE_ENTRIES.map(([, s]) => [s.field, s.column])) as {
  [K in SourceField]: (typeof mentions)[K];
};

function sourceOf(row: Record<SourceField, number | null>): MentionSource {
  for (const [type, { field }] of SOURCE_ENTRIES) {
    const id = row[field];
    if (id !== null) return { type, id };
  }
  // The table's CHECK makes this unreachable.
  throw new Error('Mention row has no source');
}

const sourceKey = (s: MentionSource) => `${s.type}:${s.id}`;

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Current usernames for a set of account ids. Ids with no account (deleted) are simply absent. */
async function usernamesFor(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.filter((r) => r.username !== null).map((r) => [r.id, r.username!]));
}

/**
 * Renders stored texts for a response, in one lookup however many there are,
 * and none at all when no text has a mention in it — which is most of them.
 */
export async function renderTexts(
  texts: (string | null | undefined)[],
): Promise<{ text: string | null; mentions: MentionRef[] }[]> {
  const ids = new Set<number>();
  for (const t of texts) if (hasTokens(t)) for (const id of tokenIds(t!)) ids.add(id);
  const names = await usernamesFor([...ids]);

  return texts.map((t) => {
    if (t === null || t === undefined) return { text: null, mentions: [] };
    if (!hasTokens(t)) return { text: t, mentions: [] };
    return render(t, names);
  });
}

/**
 * Replaces `item[key]` with its rendered text and adds the positions of the
 * linked handles as `mentions` (or `mentionsKey`). The usual way a read path
 * hands mentionable text to a client.
 */
export async function withRenderedMentions<T extends Record<K, string | null>, K extends keyof T, M extends string = 'mentions'>(
  items: T[],
  key: K,
  mentionsKey: M = 'mentions' as M,
): Promise<(T & Record<M, MentionRef[]>)[]> {
  const rendered = await renderTexts(items.map((i) => i[key]));
  return items.map((item, i) => ({
    ...item,
    [key]: rendered[i].text,
    [mentionsKey]: rendered[i].mentions,
  })) as (T & Record<M, MentionRef[]>)[];
}

// ── Write path ────────────────────────────────────────────────────────────────

/**
 * Prepares user-typed text for storage: every `@handle` that names an account
 * becomes a token. Returns the text to store and who it mentions. Null and
 * undefined pass through, so callers can feed it an optional field as-is.
 */
async function prepare<T extends string | null | undefined>(
  text: T,
): Promise<{ text: T; mentionedIds: number[] }> {
  if (text === null || text === undefined) return { text, mentionedIds: [] };

  // Only so many people can be linked per text anyway (MAX_MENTIONS_PER_TEXT);
  // looking up more than a margin over that is a query sized by whoever wrote
  // the longest list of handles.
  const handles = extractHandles(text).slice(0, MAX_MENTIONS_PER_TEXT * 2);
  const rows = handles.length
    ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.username, handles))
    : [];
  const ids = new Map(rows.map((r) => [r.username!, r.id]));
  const result = tokenize(text, ids);
  return { text: result.text as T, mentionedIds: result.mentionedIds };
}

/**
 * Brings the `mentions` rows for `source` in line with `mentionedIds`, so that
 * each person is told about a piece of text at most once however often it is
 * edited:
 *
 *  - Someone newly mentioned gets a row, still to be notified.
 *  - Someone no longer mentioned who was never told (the text was private)
 *    loses the row, and with it the notification that was waiting.
 *  - Someone no longer mentioned who *was* told keeps the row, marked removed.
 *    Deleting it would make putting the mention back create a fresh,
 *    un-notified row — a second notification for the same text, and a way to
 *    ping someone over and over by editing a handle out and in again.
 *  - Someone mentioned again after a removal has that row revived, and is not
 *    told again.
 */
async function record(source: MentionSource, authorId: number | null, mentionedIds: number[]): Promise<void> {
  const ids = [...new Set(mentionedIds)].filter((id) => id !== authorId);
  const ofSource = eq(SOURCES[source.type].column, source.id);
  const notMentioned = ids.length ? notInArray(mentions.mentionedUserId, ids) : undefined;

  await Promise.all([
    db.delete(mentions).where(and(ofSource, notMentioned, isNull(mentions.notifiedAt))),
    db
      .update(mentions)
      .set({ removedAt: new Date() })
      .where(and(ofSource, notMentioned, isNotNull(mentions.notifiedAt), isNull(mentions.removedAt))),
  ]);

  if (ids.length === 0) return;
  await Promise.all([
    db
      .update(mentions)
      .set({ removedAt: null })
      .where(and(ofSource, inArray(mentions.mentionedUserId, ids), isNotNull(mentions.removedAt))),
    db
      .insert(mentions)
      .values(ids.map((mentionedUserId) => ({ mentionedUserId, authorId, [SOURCES[source.type].field]: source.id })))
      .onConflictDoNothing(),
  ]);
}

// ── Context ───────────────────────────────────────────────────────────────────

/**
 * Text, audience and navigation target for a set of sources, in one query per
 * kind of source rather than one per source. Shared by dispatch and the feed,
 * so "who can see this" is answered the same way in both.
 */
async function loadContexts(sources: MentionSource[]): Promise<Map<string, SourceContext>> {
  const byType = new Map<MentionSourceType, number[]>();
  for (const s of sources) byType.set(s.type, [...(byType.get(s.type) ?? []), s.id]);
  const out = new Map<string, SourceContext>();
  const put = (type: MentionSourceType, id: number, ctx: SourceContext) => out.set(sourceKey({ type, id }), ctx);

  await Promise.all([...byType].map(async ([type, ids]) => {
    switch (type) {
      case 'post': {
        const rows = await db
          .select({ id: posts.id, body: posts.body, isPublic: posts.isPublic, ownerId: posts.userId, bookId: posts.bookId, bookTitle: books.title })
          .from(posts)
          .innerJoin(books, eq(books.id, posts.bookId))
          .where(inArray(posts.id, ids));
        for (const r of rows) {
          put(type, r.id, {
            text: r.body,
            audience: r.isPublic ? { kind: 'everyone' } : { kind: 'owner', ownerId: r.ownerId },
            target: { postId: r.id, bookId: r.bookId, bookTitle: r.bookTitle },
          });
        }
        break;
      }
      case 'comment': {
        const rows = await db
          .select({
            id: comments.id, body: comments.body, postId: posts.id, isPublic: posts.isPublic,
            ownerId: posts.userId, bookId: posts.bookId, bookTitle: books.title,
          })
          .from(comments)
          .innerJoin(posts, eq(posts.id, comments.postId))
          .innerJoin(books, eq(books.id, posts.bookId))
          .where(inArray(comments.id, ids));
        for (const r of rows) {
          // A comment is exactly as visible as the post it sits under.
          put(type, r.id, {
            text: r.body,
            audience: r.isPublic ? { kind: 'everyone' } : { kind: 'owner', ownerId: r.ownerId },
            target: { postId: r.postId, commentId: r.id, bookId: r.bookId, bookTitle: r.bookTitle },
          });
        }
        break;
      }
      case 'group': {
        const rows = await db
          .select({ id: groups.id, description: groups.description, name: groups.name })
          .from(groups)
          .where(inArray(groups.id, ids));
        for (const r of rows) {
          // A group's description is shown to everyone, private groups included.
          put(type, r.id, { text: r.description, audience: { kind: 'everyone' }, target: { groupId: r.id, groupName: r.name } });
        }
        break;
      }
      case 'group_book': {
        const rows = await db
          .select({
            id: groupBooks.id, description: groupBooks.description, groupId: groups.id, groupName: groups.name,
            privacy: groups.privacy, bookId: groupBooks.bookId, bookTitle: books.title,
          })
          .from(groupBooks)
          .innerJoin(groups, eq(groups.id, groupBooks.groupId))
          .innerJoin(books, eq(books.id, groupBooks.bookId))
          .where(inArray(groupBooks.id, ids));
        for (const r of rows) {
          put(type, r.id, {
            text: r.description,
            audience: { kind: 'group', groupId: r.groupId, privacy: r.privacy },
            target: { groupId: r.groupId, groupName: r.groupName, groupBookId: r.id, bookId: r.bookId, bookTitle: r.bookTitle },
          });
        }
        break;
      }
      case 'group_comment': {
        const rows = await db
          .select({
            id: groupBookComments.id, body: groupBookComments.body, parentId: groupBookComments.parentId,
            groupBookId: groupBooks.id, groupId: groups.id, groupName: groups.name, privacy: groups.privacy,
            bookId: groupBooks.bookId, bookTitle: books.title,
          })
          .from(groupBookComments)
          .innerJoin(groupBooks, eq(groupBooks.id, groupBookComments.groupBookId))
          .innerJoin(groups, eq(groups.id, groupBooks.groupId))
          .innerJoin(books, eq(books.id, groupBooks.bookId))
          .where(inArray(groupBookComments.id, ids));
        for (const r of rows) {
          put(type, r.id, {
            text: r.body,
            audience: { kind: 'group', groupId: r.groupId, privacy: r.privacy },
            target: {
              groupId: r.groupId, groupName: r.groupName, groupBookId: r.groupBookId,
              groupCommentId: r.id, parentCommentId: r.parentId, bookId: r.bookId, bookTitle: r.bookTitle,
            },
          });
        }
        break;
      }
      case 'book_note': {
        const rows = await db
          .select({
            id: userBooks.id, note: userBooks.note, isPublic: userBooks.noteIsPublic, ownerId: userBooks.userId,
            bookId: userBooks.bookId, bookTitle: books.title,
          })
          .from(userBooks)
          .innerJoin(books, eq(books.id, userBooks.bookId))
          .where(inArray(userBooks.id, ids));
        for (const r of rows) {
          put(type, r.id, {
            text: r.note,
            audience: r.isPublic ? { kind: 'everyone' } : { kind: 'owner', ownerId: r.ownerId },
            target: { bookId: r.bookId, bookTitle: r.bookTitle },
          });
        }
        break;
      }
    }
  }));

  return out;
}

/** "groupId:userId" for every active membership among these groups and people. */
async function activeMemberships(groupIds: number[], userIds: number[]): Promise<Set<string>> {
  if (groupIds.length === 0 || userIds.length === 0) return new Set();
  const rows = await db
    .select({ groupId: groupMemberships.groupId, userId: groupMemberships.userId })
    .from(groupMemberships)
    .where(
      and(
        inArray(groupMemberships.groupId, [...new Set(groupIds)]),
        inArray(groupMemberships.userId, [...new Set(userIds)]),
        eq(groupMemberships.status, 'active'),
      ),
    );
  return new Set(rows.map((r) => `${r.groupId}:${r.userId}`));
}

function decide(audience: Audience, recipientId: number, members: Set<string>): Decision {
  switch (audience.kind) {
    case 'everyone':
      return 'full';
    case 'owner':
      return audience.ownerId === recipientId ? 'full' : 'deferred';
    case 'group':
      return audience.privacy === 'public' || members.has(`${audience.groupId}:${recipientId}`) ? 'full' : 'restricted';
  }
}

function groupIdOf(ctx: SourceContext): number | null {
  return ctx.audience.kind === 'group' ? ctx.audience.groupId : null;
}

/** The first EXCERPT_LENGTH characters of the rendered text, and the handles that fit inside them. */
function excerptOf(rendered: { text: string | null; mentions: MentionRef[] }): { excerpt: string | null; mentions: MentionRef[] } {
  if (rendered.text === null) return { excerpt: null, mentions: [] };
  if (rendered.text.length <= EXCERPT_LENGTH) return { excerpt: rendered.text, mentions: rendered.mentions };
  return {
    excerpt: `${rendered.text.slice(0, EXCERPT_LENGTH)}…`,
    mentions: rendered.mentions.filter((m) => m.start + m.length <= EXCERPT_LENGTH),
  };
}

/** "…mentioned you in ___." for the push body. */
function describeWhere(type: MentionSourceType, target: MentionTarget, decision: Decision): string {
  if (decision === 'restricted') return `${target.groupName}, a private group`;
  switch (type) {
    case 'post':
      return `a review of ${target.bookTitle}`;
    case 'comment':
      return `a comment on a post about ${target.bookTitle}`;
    case 'group':
      return `the description of ${target.groupName}`;
    case 'group_book':
      return `a note on ${target.bookTitle} in ${target.groupName}`;
    case 'group_comment':
      return `a discussion of ${target.bookTitle} in ${target.groupName}`;
    case 'book_note':
      return `a note on ${target.bookTitle}`;
  }
}

async function loadPeople(ids: number[]): Promise<Map<number, MentionPerson>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, username: users.username, photoUrl: users.photoUrl })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

// ── Service ───────────────────────────────────────────────────────────────────

export const mentionsService = {
  prepare,
  record,

  /**
   * After a write: brings the source's `mentions` rows in line with its new
   * text, then sends whatever notifications are now owed.
   *
   * Never throws. The text is already saved, and it renders correctly from its
   * tokens whatever happens here — a failure costs a notification and a feed
   * entry, not the user's comment, so it is logged rather than turned into a
   * 500 for something that did in fact succeed.
   *
   * The table sync is awaited, so a "mentioned me" list read straight after
   * reflects the write; the notifications go out in the background.
   *
   * Most writes mention nobody. A new text that mentions nobody has no rows to
   * reconcile and is skipped outright; an edit still has to clear any rows its
   * earlier version left, but nothing can be owed afterwards, so dispatch is
   * skipped.
   */
  async afterWrite(
    source: MentionSource,
    authorId: number | null,
    mentionedIds: number[],
    options: AfterWriteOptions = {},
  ): Promise<void> {
    if (options.isNew && mentionedIds.length === 0) return;
    try {
      await record(source, authorId, mentionedIds);
    } catch (err) {
      logger.error('Failed to record mentions', { source, error: (err as Error).message });
      return;
    }
    if (mentionedIds.length > 0) {
      mentionsService.dispatchInBackground([source], { alreadyNotifiedIds: options.alreadyNotifiedIds });
    }
  },

  dispatchInBackground(sources: MentionSource[], options: Pick<AfterWriteOptions, 'alreadyNotifiedIds'> = {}): void {
    for (const source of sources) {
      mentionsService.dispatch(source, options).catch((err) =>
        logger.error('Failed to dispatch mention notifications', { source, error: (err as Error).message }),
      );
    }
  },

  /**
   * Sends the notifications owed for `source` that can be sent now (see the
   * file header for full / restricted / deferred). Safe to call any number of
   * times, concurrently included: each row is claimed by an UPDATE that only
   * matches while `notified_at` is still null, so nobody is told twice.
   *
   * Someone with mention notifications switched off is still marked notified —
   * otherwise switching them back on would release a backlog of old mentions.
   * So is anyone in `alreadyNotifiedIds` (see AfterWriteOptions).
   */
  async dispatch(source: MentionSource, options: Pick<AfterWriteOptions, 'alreadyNotifiedIds'> = {}): Promise<number> {
    const pending = await db
      .select({ id: mentions.id, userId: mentions.mentionedUserId, authorId: mentions.authorId })
      .from(mentions)
      .where(and(eq(SOURCES[source.type].column, source.id), isNull(mentions.notifiedAt), isNull(mentions.removedAt)));
    if (pending.length === 0) return 0;

    const ctx = (await loadContexts([source])).get(sourceKey(source));
    if (!ctx) return 0;

    const gid = groupIdOf(ctx);
    const members = gid !== null ? await activeMemberships([gid], pending.map((p) => p.userId)) : new Set<string>();
    const deliverable = pending
      .map((p) => ({ ...p, decision: decide(ctx.audience, p.userId, members) }))
      .filter((p) => p.decision !== 'deferred');
    if (deliverable.length === 0) return 0;

    const claimed = await db
      .update(mentions)
      .set({ notifiedAt: new Date() })
      .where(and(inArray(mentions.id, deliverable.map((d) => d.id)), isNull(mentions.notifiedAt)))
      .returning({ id: mentions.id });
    const claimedIds = new Set(claimed.map((c) => c.id));
    const toNotify = deliverable.filter((d) => claimedIds.has(d.id));
    if (toNotify.length === 0) return 0;

    const prefs = await db
      .select({ userId: notificationPreferences.userId, mentions: notificationPreferences.mentions })
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, toNotify.map((d) => d.userId)));
    const optedOut = new Set(prefs.filter((p) => !p.mentions).map((p) => p.userId));
    const alreadyTold = new Set(options.alreadyNotifiedIds ?? []);
    const recipients = toNotify.filter((d) => !optedOut.has(d.userId) && !alreadyTold.has(d.userId));
    if (recipients.length === 0) return 0;

    const [[rendered], people] = await Promise.all([
      renderTexts([ctx.text]),
      loadPeople(recipients.map((r) => r.authorId).filter((id): id is number => id !== null)),
    ]);
    const { excerpt, mentions: excerptMentions } = excerptOf(rendered);

    const rows = recipients.map((r) => {
      const author = r.authorId !== null ? people.get(r.authorId) : undefined;
      const restricted = r.decision === 'restricted';
      return {
        recipient: r,
        author,
        restricted,
        data: {
          sourceType: source.type,
          // A restricted notification says where, not what: no comment ids
          // that would only lead a non-member to a 403.
          ...(restricted ? withheldTarget(ctx.target) : ctx.target),
          mentionerId: author?.id ?? null,
          mentionerName: author?.name ?? null,
          mentionerUsername: author?.username ?? null,
          mentionerPhotoUrl: author?.photoUrl ?? null,
          excerpt: restricted ? null : excerpt,
          excerptMentions: restricted ? [] : excerptMentions,
          restricted,
        },
      };
    });

    await db.insert(notifications).values(rows.map((r) => ({ userId: r.recipient.userId, type: 'mention' as const, data: r.data })));

    await Promise.all(
      rows
        .filter((r) => r.author)
        .map((r) =>
          enqueuePush('mention', {
            userId: r.recipient.userId,
            mentionerName: r.author!.name,
            where: describeWhere(source.type, ctx.target, r.recipient.decision),
            data: pushData(source.type, ctx.target, r.restricted),
          }),
        ),
    );

    return rows.length;
  },

  /**
   * A post was made public: send the notifications that were held back while
   * only its author could read it — for the post itself and for every comment
   * under it, which share its visibility. Never throws; see afterWrite.
   */
  async releaseUnderPost(postId: number): Promise<void> {
    try {
      const pendingComments = await db
        .selectDistinct({ commentId: mentions.commentId })
        .from(mentions)
        .innerJoin(comments, eq(comments.id, mentions.commentId))
        .where(and(eq(comments.postId, postId), isNull(mentions.notifiedAt), isNull(mentions.removedAt)));
      mentionsService.dispatchInBackground([
        { type: 'post', id: postId },
        ...pendingComments.map((c) => ({ type: 'comment' as const, id: c.commentId! })),
      ]);
    } catch (err) {
      logger.error('Failed to release held mention notifications', { postId, error: (err as Error).message });
    }
  },

  /**
   * GET /user/mentions — every mention of the caller that has been delivered,
   * newest first.
   *
   * Visibility is re-checked on every read, not frozen at notification time: a
   * post made private after you were mentioned in it shows up here with its
   * excerpt withheld rather than leaking text you can no longer open. The
   * entry stays, so the list and its `total` do not shift under pagination.
   */
  async list(userId: number, limit: number, offset: number): Promise<{ mentions: MentionFeedItem[]; total: number }> {
    // Removed mentions drop out: the text no longer names you.
    const where = and(eq(mentions.mentionedUserId, userId), isNotNull(mentions.notifiedAt), isNull(mentions.removedAt));
    const [rows, [counted]] = await Promise.all([
      db
        .select({ id: mentions.id, authorId: mentions.authorId, createdAt: mentions.createdAt, ...SOURCE_COLUMNS })
        .from(mentions)
        .where(where)
        .orderBy(desc(mentions.createdAt), desc(mentions.id))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(mentions).where(where),
    ]);

    const sources = rows.map((r) => sourceOf(r));
    const contexts = await loadContexts(sources);
    const groupIds = [...contexts.values()].map(groupIdOf).filter((g): g is number => g !== null);
    const [members, people, rendered] = await Promise.all([
      activeMemberships(groupIds, [userId]),
      loadPeople(rows.map((r) => r.authorId).filter((id): id is number => id !== null)),
      renderTexts(sources.map((s) => contexts.get(sourceKey(s))?.text ?? null)),
    ]);

    const items: MentionFeedItem[] = rows.map((r, i) => {
      const source = sources[i];
      const ctx = contexts.get(sourceKey(source));
      // The FK cascades make a missing source unreachable; treated as withheld
      // rather than dropped so the page length always matches `limit`.
      const decision: Decision = ctx ? decide(ctx.audience, userId, members) : 'restricted';
      const visible = decision === 'full';
      const { excerpt, mentions: excerptMentions } = visible ? excerptOf(rendered[i]) : { excerpt: null, mentions: [] };
      return {
        id: r.id,
        sourceType: source.type,
        createdAt: r.createdAt,
        author: r.authorId !== null ? (people.get(r.authorId) ?? null) : null,
        excerpt,
        mentions: excerptMentions,
        restricted: !visible,
        target: ctx ? (visible ? ctx.target : withheldTarget(ctx.target)) : {},
      };
    });

    return { mentions: items, total: counted?.count ?? 0 };
  },
};

/**
 * What of a target survives when its text is withheld: enough to say where
 * (the group, the book) and to open it if you are let in, but no comment ids
 * that would only lead to a 403.
 */
function withheldTarget(t: MentionTarget): MentionTarget {
  return {
    ...(t.groupId !== undefined && { groupId: t.groupId, groupName: t.groupName }),
    ...(t.postId !== undefined && { postId: t.postId }),
    ...(t.bookId !== undefined && { bookId: t.bookId, bookTitle: t.bookTitle }),
  };
}

/** The push payload's `data`, which FCM requires to be strings. */
function pushData(type: MentionSourceType, t: MentionTarget, restricted: boolean): Record<string, string> {
  const data: Record<string, string> = { type: 'mention', sourceType: type };
  const target = restricted ? withheldTarget(t) : t;
  for (const key of ['postId', 'commentId', 'groupId', 'groupBookId', 'groupCommentId', 'parentCommentId', 'bookId'] as const) {
    const v = target[key];
    if (v !== undefined && v !== null) data[key] = String(v);
  }
  return data;
}
