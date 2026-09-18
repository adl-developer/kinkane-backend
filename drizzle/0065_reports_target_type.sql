-- Reports can now be filed against a group, not just a user.
--
-- Statement order matters and is safe as generated: reported_user_id loses its
-- NOT NULL before the shape CHECK is added, and target_type arrives with a
-- DEFAULT of 'user', so every existing row reads as a user report with a user
-- attached and no group -- which is exactly what the CHECK requires.
--
-- Note what the CHECK does NOT say. The group arm requires reported_user_id to
-- be NULL but does not require reported_group_id to be present. That asymmetry
-- is deliberate: the foreign key is ON DELETE SET NULL, so deleting a reported
-- group nulls the column, and demanding NOT NULL there would make deleting a
-- reported group fail on this constraint. A complaint has to be able to outlive
-- the thing it was filed against -- the same reasoning as post_id.
--
-- user_reports_not_self_check is untouched and still correct: a CHECK fails only
-- on FALSE, and `reporter_id != NULL` evaluates to NULL, which passes. Group
-- reports simply never engage it.

CREATE TYPE "public"."report_target_type" AS ENUM('user', 'group');--> statement-breakpoint
ALTER TABLE "user_reports" ALTER COLUMN "reported_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "target_type" "report_target_type" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "reported_group_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_group_id_groups_id_fk" FOREIGN KEY ("reported_group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_reported_group_id" ON "user_reports" USING btree ("reported_group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_target_type" ON "user_reports" USING btree ("target_type");--> statement-breakpoint
ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_target_shape" CHECK (("user_reports"."target_type" = 'user' AND "user_reports"."reported_user_id" IS NOT NULL AND "user_reports"."reported_group_id" IS NULL)
          OR ("user_reports"."target_type" = 'group' AND "user_reports"."reported_user_id" IS NULL));