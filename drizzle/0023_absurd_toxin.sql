CREATE TYPE "public"."subscription_event_type" AS ENUM('started', 'extended', 'expired', 'converted', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'expired' BEFORE 'cancelled';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event" "subscription_event_type" NOT NULL,
	"previous_trial_ends_at" timestamp with time zone,
	"new_trial_ends_at" timestamp with time zone,
	"admin_user_id" integer,
	"reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "trial_expired_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_events_user_id" ON "subscription_events" USING btree ("user_id");