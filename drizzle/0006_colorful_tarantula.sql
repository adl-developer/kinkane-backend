CREATE TYPE "public"."follow_request_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "follow_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"sender_id" integer NOT NULL,
	"receiver_id" integer NOT NULL,
	"status" "follow_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "follow_requests" ADD CONSTRAINT "follow_requests_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_follow_requests_sender_receiver" ON "follow_requests" USING btree ("sender_id","receiver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_follow_requests_receiver_id" ON "follow_requests" USING btree ("receiver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_follow_requests_sender_id" ON "follow_requests" USING btree ("sender_id");--> statement-breakpoint
ALTER TABLE "public"."posts" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
UPDATE "public"."posts" SET "status" = 'reading' WHERE "status" = 'reading_now';--> statement-breakpoint
UPDATE "public"."posts" SET "status" = 'read' WHERE "status" = 'finished_reading';--> statement-breakpoint
DROP TYPE "public"."post_status";--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('reading', 'read');--> statement-breakpoint
ALTER TABLE "public"."posts" ALTER COLUMN "status" SET DATA TYPE "public"."post_status" USING "status"::"public"."post_status";