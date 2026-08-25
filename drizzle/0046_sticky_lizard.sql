CREATE TYPE "public"."admin_notification_type" AS ENUM('report_filed', 'order_received', 'customer_registered', 'order_delivered');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('pending', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "admin_notification_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"order_id" integer,
	"user_id" integer,
	"report_id" integer,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admins" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" varchar(500) NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcement_banners" (
	"slot" varchar(20) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"text" varchar(200) NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blacklisted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blacklisted_by" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "blacklist_reason" text;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "reference" varchar(16);--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "status" "report_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "resolved_by" integer;--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_notifications" ADD CONSTRAINT "admin_notifications_report_id_user_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."user_reports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "announcement_banners" ADD CONSTRAINT "announcement_banners_updated_by_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_notifications_created_at" ON "admin_notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_notifications_read_at" ON "admin_notifications" USING btree ("read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admins_email" ON "admins" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_status" ON "user_reports" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_reports_reference" ON "user_reports" USING btree ("reference");--> statement-breakpoint

-- Hand-added below this line.
--
-- Existing reports predate the reference column and the moderation queue shows
-- "R003", not a database id. Backfilled from the id so every row has one; new
-- rows get theirs at insert. The unique index tolerates the nulls in between
-- because Postgres does not consider two nulls equal.
UPDATE "user_reports" SET "reference" = 'R' || lpad("id"::text, 3, '0') WHERE "reference" IS NULL;--> statement-breakpoint

-- The two storefront strips, seeded with the copy from the designs so the
-- public banner endpoint has something to return on a fresh database. Both
-- start enabled, matching how the site is drawn.
INSERT INTO "announcement_banners" ("slot", "enabled", "text") VALUES
  ('top', true, 'We Ship Worldwide!'),
  ('second', true, '15% Off Your First Order')
ON CONFLICT ("slot") DO NOTHING;
