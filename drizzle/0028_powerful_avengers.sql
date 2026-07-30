DROP INDEX IF EXISTS "idx_user_interactions_trending";--> statement-breakpoint
--
-- Collapse pre-existing duplicate non-view signals down to the earliest row for
-- each (user, book, type), keeping the original timestamp. Without this the unique
-- index below cannot be created on any database that already has duplicates — and
-- the onboarding seed could produce them whenever a guest's chosen book list
-- repeated an ID.
--
DELETE FROM "user_interactions" a
USING "user_interactions" b
WHERE a."type" <> 'view'
  AND b."type" <> 'view'
  AND a."user_id" = b."user_id"
  AND a."book_id" = b."book_id"
  AND a."type"    = b."type"
  AND a."id"      > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_interactions_unique_non_view" ON "user_interactions" USING btree ("user_id","book_id","type") WHERE "user_interactions"."type" <> 'view';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_interactions_trending" ON "user_interactions" USING btree ("created_at","type","book_id");