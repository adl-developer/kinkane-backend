CREATE TYPE "public"."subscription_plan" AS ENUM('monthly', 'annual');--> statement-breakpoint
ALTER TYPE "public"."subscription_event_type" ADD VALUE 'renewed';--> statement-breakpoint
ALTER TYPE "public"."subscription_event_type" ADD VALUE 'payment_failed';--> statement-breakpoint
ALTER TYPE "public"."subscription_event_type" ADD VALUE 'resumed';--> statement-breakpoint
ALTER TYPE "public"."subscription_event_type" ADD VALUE 'plan_changed';--> statement-breakpoint
ALTER TYPE "public"."subscription_event_type" ADD VALUE 'refunded';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'past_due';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'incomplete';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
	"event_id" varchar(256) PRIMARY KEY NOT NULL,
	"type" varchar(100) NOT NULL,
	"payload" jsonb,
	"error" varchar(1000),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription_state_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"tier" "subscription_tier" NOT NULL,
	"status" "subscription_status" NOT NULL,
	"plan" "subscription_plan",
	"price_id" varchar(256),
	"is_founding_member" boolean DEFAULT false NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"stripe_subscription_id" varchar(256),
	"reason" varchar(100) NOT NULL,
	"source_event_id" varchar(256),
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "currency" varchar(10);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "stripe_invoice_id" varchar(256);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "stripe_event_id" varchar(256);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "plan" "subscription_plan";--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "price_id" varchar(256);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "is_founding_member" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscription_state_history" ADD CONSTRAINT "subscription_state_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stripe_webhook_events_type" ON "stripe_webhook_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stripe_webhook_events_received_at" ON "stripe_webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_state_history_user_id" ON "subscription_state_history" USING btree ("user_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscription_state_history_open" ON "subscription_state_history" USING btree ("user_id") WHERE "subscription_state_history"."effective_to" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_subscription_events_created_at" ON "subscription_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_subscriptions_stripe_customer_id" ON "user_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_subscriptions_stripe_subscription_id" ON "user_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
-- Backfill: open one history interval per existing subscription, dated from
-- when the subscription row was created. Without this, every account that
-- predates this migration would have no history until its next state change,
-- and "what were they on in March" would silently return nothing for them.
-- The interval is left open (effective_to null), which is what makes it the
-- current state; the partial unique index guarantees there's only one.
INSERT INTO "subscription_state_history" (
  "user_id", "tier", "status", "plan", "price_id", "is_founding_member",
  "trial_ends_at", "current_period_end", "cancel_at_period_end",
  "stripe_subscription_id", "reason", "effective_from"
)
SELECT
  "user_id", "tier", "status", "plan", "price_id", "is_founding_member",
  "trial_ends_at", "current_period_end", "cancel_at_period_end",
  "stripe_subscription_id", 'backfill', "created_at"
FROM "user_subscriptions"
ON CONFLICT DO NOTHING;