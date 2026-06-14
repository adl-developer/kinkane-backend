CREATE TABLE IF NOT EXISTS "posts" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "book_id" integer NOT NULL REFERENCES "books"("id") ON DELETE CASCADE,
  "rating" smallint NOT NULL,
  "body" text,
  "is_public" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "posts_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS "idx_posts_user_id" ON "posts"("user_id");
CREATE INDEX IF NOT EXISTS "idx_posts_book_id" ON "posts"("book_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_posts_user_book" ON "posts"("user_id", "book_id");

CREATE TABLE IF NOT EXISTS "post_likes" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "post_id" integer NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_post_likes_user_post" ON "post_likes"("user_id", "post_id");
CREATE INDEX IF NOT EXISTS "idx_post_likes_post_id" ON "post_likes"("post_id");

CREATE TABLE IF NOT EXISTS "comments" (
  "id" serial PRIMARY KEY,
  "post_id" integer NOT NULL REFERENCES "posts"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_comments_post_id" ON "comments"("post_id");
CREATE INDEX IF NOT EXISTS "idx_comments_user_id" ON "comments"("user_id");

CREATE TABLE IF NOT EXISTS "comment_likes" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "comment_id" integer NOT NULL REFERENCES "comments"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_comment_likes_user_comment" ON "comment_likes"("user_id", "comment_id");
CREATE INDEX IF NOT EXISTS "idx_comment_likes_comment_id" ON "comment_likes"("comment_id");
