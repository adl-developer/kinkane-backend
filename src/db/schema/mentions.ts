import { pgTable, serial, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { posts, comments } from './community';
import { groups } from './groups';
import { groupBooks, groupBookComments } from './group-books';
import { userBooks } from './onboarding';

/**
 * One person mentioned in one piece of text.
 *
 * The text itself is the source of truth for what a mention *looks like* — it
 * carries `@{{u:<id>}}` tokens that render as the current username (see
 * lib/mention-text.ts). This table exists for everything the text cannot answer
 * cheaply: who to notify, whether they have been, and "where have I been
 * mentioned" without scanning every comment ever written.
 *
 * WHY ONE COLUMN PER SOURCE rather than a (source_type, source_id) pair. A
 * polymorphic pair cannot carry a foreign key, so deleting a post, a comment, a
 * group or a shelf entry would leave its mentions behind — and there are a
 * dozen delete paths, several of them cascades nobody calls code for (a deleted
 * account takes its posts, a deleted top-level group comment takes its replies,
 * a deleted group takes its whole shelf). Real FKs with ON DELETE CASCADE make
 * every one of those clean up after itself. The CHECK keeps exactly one set.
 *
 * An edit syncs the rows: see mentionsService.record for how removal works.
 *
 * Self-mentions are not stored: they render as a link like any other, but there
 * is nobody to notify and nothing for a "mentioned me" list to show.
 */
export const mentions = pgTable(
  'mentions',
  {
    id: serial('id').primaryKey(),
    mentionedUserId: integer('mentioned_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SET NULL, not cascade: every source below is already removed with its
    // author's account, so this only matters for the group description, which
    // belongs to the group rather than to whoever typed it.
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),

    // Exactly one of these is set — see the CHECK below.
    postId: integer('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    commentId: integer('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    groupBookId: integer('group_book_id').references(() => groupBooks.id, { onDelete: 'cascade' }),
    groupCommentId: integer('group_comment_id').references(() => groupBookComments.id, { onDelete: 'cascade' }),
    userBookId: integer('user_book_id').references(() => userBooks.id, { onDelete: 'cascade' }),

    // When the mentioned person was told — or deliberately not told, because
    // they have mention notifications switched off. Null means "still owed":
    // the text is somewhere they cannot see yet (a private post, a private
    // note), and the notification goes out if and when it becomes visible.
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    // Set when an edit takes the mention out after the person was already
    // told. The row is kept rather than deleted so that putting the mention
    // back revives it instead of creating a fresh, un-notified row — otherwise
    // removing and re-adding a handle would notify the person again on every
    // edit. Removed rows are invisible to the feed and to dispatch.
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    oneSource: check(
      'mentions_one_source',
      sql`num_nonnulls(${t.postId}, ${t.commentId}, ${t.groupId}, ${t.groupBookId}, ${t.groupCommentId}, ${t.userBookId}) = 1`,
    ),
    // One row per person per source. Source first, so the same indexes serve
    // "the mentions in this post" when an edit re-syncs them. NULLs never
    // collide, so each index only constrains rows of its own source.
    postUniq: uniqueIndex('idx_mentions_post_user').on(t.postId, t.mentionedUserId),
    commentUniq: uniqueIndex('idx_mentions_comment_user').on(t.commentId, t.mentionedUserId),
    groupUniq: uniqueIndex('idx_mentions_group_user').on(t.groupId, t.mentionedUserId),
    groupBookUniq: uniqueIndex('idx_mentions_group_book_user').on(t.groupBookId, t.mentionedUserId),
    groupCommentUniq: uniqueIndex('idx_mentions_group_comment_user').on(t.groupCommentId, t.mentionedUserId),
    userBookUniq: uniqueIndex('idx_mentions_user_book_user').on(t.userBookId, t.mentionedUserId),
    // The "where I've been mentioned" feed, newest first.
    mentionedIdx: index('idx_mentions_mentioned_created').on(t.mentionedUserId, t.createdAt),
  }),
);

export type Mention = typeof mentions.$inferSelect;
export type NewMention = typeof mentions.$inferInsert;
