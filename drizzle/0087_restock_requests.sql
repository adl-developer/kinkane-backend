-- "Request Restock" presses from the book page, one row per press, for the
-- admin console's Restock Requests screen. Also adds the bell event for them.
CREATE TYPE "public"."restock_request_status" AS ENUM('pending', 'fulfilled');--> statement-breakpoint
ALTER TYPE "public"."admin_notification_type" ADD VALUE IF NOT EXISTS 'restock_requested';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "restock_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(16),
	"book_id" integer NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"user_id" integer,
	"name" varchar(200),
	"email" varchar(254),
	"status" "restock_request_status" DEFAULT 'pending' NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"fulfilled_by" integer,
	"admin_emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_fulfilled_by_admins_id_fk" FOREIGN KEY ("fulfilled_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restock_requests_book_created" ON "restock_requests" USING btree ("book_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restock_requests_status" ON "restock_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_restock_requests_created_at" ON "restock_requests" USING btree ("created_at");