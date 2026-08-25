CREATE TYPE "public"."payment_kind" AS ENUM('subscription', 'order');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"reference" varchar(32) NOT NULL,
	"user_id" integer NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"stripe_checkout_session_id" varchar(255) NOT NULL,
	"stripe_payment_intent_id" varchar(255),
	"order_id" integer,
	"amount_cents" integer,
	"currency" varchar(3),
	"failure_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	CONSTRAINT "payments_reference_unique" UNIQUE("reference"),
	CONSTRAINT "payments_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_user_id" ON "payments" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payments_status" ON "payments" USING btree ("status");