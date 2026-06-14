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
    rating: smallint('rating').notNull(),
    status: postStatusEnum('status').notNull(),
    body: text('body'),
    isPublic: boolean('is_public').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdIdx: index('idx_posts_user_id').on(t.userId),
    bookIdIdx: index('idx_posts_book_id').on(t.bookId),
    userBookUniq: uniqueIndex('idx_posts_user_book').on(t.userId, t.bookId),
    ratingCheck: check('posts_rating_check', sql`${t.rating} BETWEEN 1 AND 5`),
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
