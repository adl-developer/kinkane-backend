-- Community post search also finds a post by what people wrote in its
-- comments. Same two columns and indexes as posts (0084, 0085), built with the
-- same post_search_text() so a comment, a post and the typed query are all
-- cleaned identically: search_text (trigram, for exact wording and part words)
-- and search_vector (stemmed words and phrases).
ALTER TABLE "comments" ADD COLUMN "search_text" text
  GENERATED ALWAYS AS (post_search_text(coalesce("body", ''))) STORED;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', post_search_text(coalesce("body", '')))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_comments_search_vector" ON "comments" USING GIN ("search_vector");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_comments_search_text_trgm" ON "comments" USING GIN ("search_text" gin_trgm_ops);
