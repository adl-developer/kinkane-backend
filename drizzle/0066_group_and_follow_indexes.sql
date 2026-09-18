-- Indexes for the group surfaces, plus one on follow_requests that the group
-- invite picker leans on.
--
-- ORDER MATTERS AND IS NOT THE ORDER DRIZZLE-KIT GENERATED. The two
-- follow_requests indexes are built BEFORE the single-column ones they replace
-- are dropped: follow_requests is the live social graph, and dropping first
-- would leave every follow lookup unindexed until the replacement finished.
-- They are deliberately named differently for exactly that reason.
--
-- The concurrent twins in src/db/build-concurrent-indexes.ts build these ahead
-- of the migration, so in a deployed environment the CREATEs below find them
-- present and no-op, and the DROPs find the old ones already gone. On a fresh
-- or local database this file does the whole job under a lock, which costs
-- nothing on an empty table.
--
-- group_memberships and groups are new and empty, so their indexes are simply
-- replaced in place.

CREATE INDEX IF NOT EXISTS "idx_follow_requests_receiver_status" ON "follow_requests" USING btree ("receiver_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_follow_requests_sender_status" ON "follow_requests" USING btree ("sender_id","status");--> statement-breakpoint
DROP INDEX IF EXISTS "idx_follow_requests_receiver_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_follow_requests_sender_id";--> statement-breakpoint
-- Browsing clubs is "newest first" with a LIMIT; without this every page sorts
-- the whole table.
CREATE INDEX IF NOT EXISTS "idx_groups_created_at" ON "groups" USING btree ("created_at" desc);--> statement-breakpoint
-- joined_at trails each key so the member list and "your groups" read straight
-- off the index in order, instead of fetching every member of a club to return
-- a page of twenty.
DROP INDEX IF EXISTS "idx_group_memberships_user_status";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_group_memberships_group_status";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_memberships_user_status" ON "group_memberships" USING btree ("user_id","status","joined_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_memberships_group_status" ON "group_memberships" USING btree ("group_id","status","joined_at");
