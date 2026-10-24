import {
  pgTable,
  serial,
  integer,
  smallint,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { tsvector } from './column-types';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { books } from './books';


export const postStatusEnum = pgEnum('post_status', ['reading', 'read']);

export const posts = pgTable(
  'posts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    // Null only on a `reading` post — a finished book must be rated.
    rating: smallint('rating'),
    status: postStatusEnum('status').notNull(),
    body: text('body'),
    isPublic: boolean('is_public').notNull().default(true),
    // Hidden by a moderator. Hiding makes the post private — so every rule that
    // already keeps private posts author-only applies, with nothing new to
    // enforce — and remembers what it was, so unhiding puts it back. No FK on
    // hidden_by, as with users.blacklistedBy.
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenBy: integer('hidden_by'),
    hiddenWasPublic: boolean('hidden_was_public'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Bumped by any change, visibility included — not a signal of an edit.
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Set only when the body, rating or status actually changes, so the app
    // can mark the post "Edited". Making a post public or private is not an edit.
    editedAt: timestamp('edited_at', { withTimezone: true }),
    // Both GENERATED ALWAYS from `body` in drizzle/0084 — never written from
    // the app. The body with its @mention and link tokens blanked out and
    // lowercased: `searchText` for substring matches, `searchVector` for words
    // and phrases. Their indexes (GIN, gin_trgm_ops) are hand-written there too.
    searchText: text('search_text'),
    searchVector: tsvector('search_vector'),
  },
  (t) => ({
    userIdIdx: index('idx_posts_user_id').on(t.userId),
    bookIdIdx: index('idx_posts_book_id').on(t.bookId),
    // A reader can post about a book many times (one while reading, another
    // when finished); this finds their latest post for a book.
    userBookIdx: index('idx_posts_user_book_created').on(t.userId, t.bookId, t.createdAt.desc()),
    ratingCheck: check('posts_rating_check', sql`${t.rating} BETWEEN 0 AND 5`),
    readRatingCheck: check('posts_read_rating_check', sql`${t.status} <> 'read' OR ${t.rating} IS NOT NULL`),
  }),
);

export const postLikes = pgTable(
  'post_likes',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex('idx_post_likes_user_post').on(t.userId, t.postId),
    postIdIdx: index('idx_post_likes_post_id').on(t.postId),
  }),
);

export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Set only when the body actually changes — see posts.editedAt.
    editedAt: timestamp('edited_at', { withTimezone: true }),
    // Hidden by a moderator: shown to its author only.
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenBy: integer('hidden_by'),
  },
  (t) => ({
    postIdIdx: index('idx_comments_post_id').on(t.postId),
    userIdIdx: index('idx_comments_user_id').on(t.userId),
  }),
);

export const commentLikes = pgTable(
  'comment_likes',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commentId: integer('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex('idx_comment_likes_user_comment').on(t.userId, t.commentId),
    commentIdIdx: index('idx_comment_likes_comment_id').on(t.commentId),
  }),
);

export type PostStatus = 'reading' | 'read';
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
