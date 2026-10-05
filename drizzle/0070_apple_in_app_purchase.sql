CREATE TYPE "public"."billing_provider" AS ENUM('stripe', 'apple');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apple_notification_events" (
	"notification_id" varchar(64) PRIMARY KEY NOT NULL,
	"type" varchar(100) NOT NULL,
	"original_transaction_id" varchar(64),
	"environment" varchar(20),
	"payload" jsonb,
	"error" varchar(1000),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "apple_transaction_id" varchar(64);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD COLUMN "apple_notification_id" varchar(64);--> statement-breakpoint
ALTER TABLE "subscription_state_history" ADD COLUMN "billing_provider" "billing_provider";--> statement-breakpoint
ALTER TABLE "subscription_state_history" ADD COLUMN "apple_original_transaction_id" varchar(64);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "billing_provider" "billing_provider";--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "apple_original_transaction_id" varchar(64);--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "apple_environment" varchar(20);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apple_notification_events_original_transaction_id" ON "apple_notification_events" USING btree ("original_transaction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apple_notification_events_received_at" ON "apple_notification_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_subscriptions_apple_original_transaction_id" ON "user_subscriptions" USING btree ("apple_original_transaction_id");--> statement-breakpoint
-- Everyone who has ever had a Stripe subscription is billed by Stripe. The open
-- history interval is updated in place (not closed and reopened): the provider
-- was always Stripe, this only writes down what was already true.
UPDATE "user_subscriptions" SET "billing_provider" = 'stripe' WHERE "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
UPDATE "subscription_state_history" SET "billing_provider" = 'stripe' WHERE "stripe_subscription_id" IS NOT NULL;
