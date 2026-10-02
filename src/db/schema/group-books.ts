import {
  pgTable,
  serial,
  integer,
  text,
  date,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgEnum,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql, desc } from 'drizzle-orm';
import { users } from './users';
import { books } from './books';
import { groups } from './groups';

/**
 * Which of a group's three shelves a book is on.
 *
 * A status on one row rather than three tables: a book can only be on one shelf
 * at a time, and moving it — want to read → currently reading → finished — is
 * then an UPDATE that keeps its history and its discussion, not a delete and a
 * re-insert that loses both.
 */
export const groupBookStatusEnum = pgEnum('group_book_status', [
  'want_to_read',
  'currently_reading',
  'finished',
]);

export const groupBooks = pgTable(
  'group_books',
  {
    id: serial('id').primaryKey(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    status: groupBookStatusEnum('status').notNull(),
    // The owner's note on the current read ("Description" on Mark as Currently
    // Reading). Kept when the book moves to Finished.
    description: text('description'),
    // `date`, not `timestamptz`: the picker chooses a calendar day. A timestamp
    // at UTC midnight renders as the previous day for everyone west of UTC.
    startedOn: date('started_on', { mode: 'string' }),
    finishedOn: date('finished_on', { mode: 'string' }),
    // SET NULL: the shelf belongs to the group, not to whoever added the book.
    addedBy: integer('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // One row per book per group — the same book cannot sit on two shelves.
    // Also what makes the batched want-to-read insert's ON CONFLICT DO NOTHING
    // report "already on the shelf" correctly.
    groupBookUniq: uniqueIndex('idx_group_books_group_book').on(t.groupId, t.bookId),
    // One current read per group, enforced by the database. Two owner devices
    // racing to set it get one success and one unique violation (→ 409) rather
    // than two current books and a group page that has to pick one.
    oneCurrentPerGroup: uniqueIndex('idx_group_books_one_current')
      .on(t.groupId)
      .where(sql`${t.status} = 'currently_reading'`),
    // List pages: one shelf of one group, newest first.
    groupStatusIdx: index('idx_group_books_group_status').on(t.groupId, t.status, desc(t.addedAt)),
    startedOnPresent: check(
      'group_books_started_on_present',
      sql`${t.status} <> 'currently_reading' OR ${t.startedOn} IS NOT NULL`,
    ),
    finishedOnPresent: check(
      'group_books_finished_on_present',
      sql`${t.status} <> 'finished' OR ${t.finishedOn} IS NOT NULL`,
    ),
    // Passes when either date is NULL — a CHECK fails only on FALSE.
    dateOrder: check('group_books_date_order', sql`${t.finishedOn} >= ${t.startedOn}`),
  }),
);

/**
 * Discussion of a book on a group's shelf.
 *
 * Separate from the community `comments` table, which is hard-wired to a post.
 * The thread hangs off the `group_books` row, so it survives the book moving to
 * Finished and goes only when the book is taken off the shelf or the group is
 * deleted.
 *
 * One level of nesting: a top-level comment (parent_id NULL) and its replies.
 * The design shows reply counts on top-level comments and none on replies. The
 * service, not a CHECK, rejects a reply to a reply — the rule spans two rows.
 */
export const groupBookComments = pgTable(
  'group_book_comments',
  {
    id: serial('id').primaryKey(),
    groupBookId: integer('group_book_id')
      .notNull()
      .references(() => groupBooks.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    parentId: integer('parent_id').references((): AnyPgColumn => groupBookComments.id, {
      onDelete: 'cascade',
    }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Top-level page (parent_id IS NULL) and the comment count read off this.
    threadIdx: index('idx_group_book_comments_thread').on(t.groupBookId, t.parentId, t.createdAt),
    // Replies page and per-page reply counts.
    parentIdx: index('idx_group_book_comments_parent').on(t.parentId, t.createdAt),
    userIdIdx: index('idx_group_book_comments_user_id').on(t.userId),
  }),
);

export const groupBookCommentLikes = pgTable(
  'group_book_comment_likes',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commentId: integer('comment_id')
      .notNull()
      .references(() => groupBookComments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex('idx_group_book_comment_likes_user_comment').on(t.userId, t.commentId),
    commentIdIdx: index('idx_group_book_comment_likes_comment_id').on(t.commentId),
  }),
);

export type GroupBook = typeof groupBooks.$inferSelect;
export type GroupBookStatus = (typeof groupBookStatusEnum.enumValues)[number];
export type GroupBookComment = typeof groupBookComments.$inferSelect;
