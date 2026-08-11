ALTER TABLE "subscription_state_history" ADD COLUMN "pending_plan" "subscription_plan";--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "pending_plan" "subscription_plan";