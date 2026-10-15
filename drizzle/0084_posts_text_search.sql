-- Community search matches what people wrote in a post, not only the title of
-- the book it is about. Hand-written: drizzle-kit cannot emit GENERATED ALWAYS
-- columns, USING GIN or gin_trgm_ops.
--
-- Both columns are generated from body, so there is no backfill and nothing in
-- the app can let them drift. Before indexing, the stored @mention tokens
-- (@{{u:123}}) and link tokens ({{l:123}}) are blanked out — otherwise "u" or
-- an account id would match every post that mentions someone.
--
-- Lowercased under ICU rather than the database's own ctype: the database is
-- ctype C, where lower() and to_tsvector leave non-ASCII capitals alone, so
-- "Émile" would never match "émile". The app lowercases the query the same way.
--
-- search_text backs substring matches (part of a word, or the exact wording);
-- search_vector backs word and "quoted phrase" matches, with English stemming
-- so "reading" finds "read" — a post is prose, unlike user and group names.
ALTER TABLE "posts" ADD COLUMN "search_text" text
  GENERATED ALWAYS AS (
    lower(regexp_replace(coalesce("body", ''), '@\{\{u:[0-9]+\}\}|\{\{l:[0-9]+\}\}', ' ', 'g') COLLATE "und-x-icu")
  ) STORED;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', lower(regexp_replace(coalesce("body", ''), '@\{\{u:[0-9]+\}\}|\{\{l:[0-9]+\}\}', ' ', 'g') COLLATE "und-x-icu"))
  ) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_posts_search_vector" ON "posts" USING GIN ("search_vector");--> statement-breakpoint
-- Backs the LIKE '%…%' substring tier. Without it that is a sequential scan
-- over every post.
CREATE INDEX IF NOT EXISTS "idx_posts_search_text_trgm" ON "posts" USING GIN ("search_text" gin_trgm_ops);
