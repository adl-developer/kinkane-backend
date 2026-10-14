-- A reader may now post about the same book more than once (one while reading,
-- another when finished). Existing rows keep edited_at NULL: past text edits
-- cannot be told apart from visibility toggles, which also bumped updated_at.
DROP INDEX IF EXISTS "idx_posts_user_book";--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_posts_user_book_created" ON "posts" USING btree ("user_id","book_id","created_at" DESC NULLS LAST);