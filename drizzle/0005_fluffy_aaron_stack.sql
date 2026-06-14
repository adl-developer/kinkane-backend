ALTER TABLE "users" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_search_vector" ON "users" USING btree ("search_vector");