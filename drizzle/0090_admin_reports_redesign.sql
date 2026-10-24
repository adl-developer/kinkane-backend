CREATE TYPE "public"."report_category" AS ENUM('user', 'group', 'content');--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "hidden_by" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "hidden_by" integer;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "hidden_was_public" boolean;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "blacklisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "blacklisted_by" integer;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "blacklist_reason" text;--> statement-breakpoint
ALTER TABLE "group_book_comments" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_book_comments" ADD COLUMN "hidden_by" integer;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "category" "report_category" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "reason_category" varchar(100);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_category" ON "user_reports" USING btree ("category","status");--> statement-breakpoint
-- Existing reports onto their tabs: a group report is a group report, and a
-- user report that cites a post, review or comment is about that content.
UPDATE "user_reports" SET "category" = CASE
  WHEN "target_type" = 'group' THEN 'group'::"report_category"
  WHEN "post_id" IS NOT NULL OR "comment_id" IS NOT NULL OR "group_comment_id" IS NOT NULL THEN 'content'::"report_category"
  ELSE 'user'::"report_category"
END;--> statement-breakpoint
-- One reference series per tab: R001 for people, GR001 for groups, CR001 for
-- content. References already issued are kept as they are, so R carries on
-- after the highest one used; GR and CR start at 1.
CREATE SEQUENCE IF NOT EXISTS "report_reference_user_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "report_reference_group_seq";--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "report_reference_content_seq";--> statement-breakpoint
SELECT setval('report_reference_user_seq', GREATEST(COALESCE((SELECT max("id") FROM "user_reports"), 0), 1), (SELECT count(*) > 0 FROM "user_reports"));
