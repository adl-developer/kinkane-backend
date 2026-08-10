CREATE TYPE "public"."continent" AS ENUM('AF', 'EU', 'AS', 'NA', 'SA', 'OC');--> statement-breakpoint
CREATE TYPE "public"."referral_point_kind" AS ENUM('same_country', 'same_continent', 'cross_continent', 'full_circuit');--> statement-breakpoint
CREATE TYPE "public"."referral_point_state" AS ENUM('counted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('active', 'voided');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "countries" (
	"code" char(2) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"continent" "continent" NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_clicks" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_id" integer NOT NULL,
	"channel" varchar(20),
	"ip_hash" varchar(64),
	"user_agent" varchar(500),
	"country_code" char(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" varchar(32) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "referral_codes_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"referral_id" integer,
	"kind" "referral_point_kind" NOT NULL,
	"points" integer NOT NULL,
	"state" "referral_point_state" DEFAULT 'counted' NOT NULL,
	"season_id" integer DEFAULT 1 NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(200)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_user_id" integer NOT NULL,
	"referred_user_id" integer NOT NULL,
	"code_id" integer,
	"click_id" integer,
	"status" "referral_status" DEFAULT 'active' NOT NULL,
	"channel" varchar(20),
	"depth" integer NOT NULL,
	"root_referrer_id" integer NOT NULL,
	"ancestor_path" integer[] NOT NULL,
	"referrer_country" char(2),
	"redeemer_country" char(2),
	"referrer_tier_at_referral" "subscription_tier",
	"signed_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" varchar(200),
	CONSTRAINT "referrals_referred_user_id_unique" UNIQUE("referred_user_id"),
	CONSTRAINT "referrals_no_self_referral" CHECK ("referrals"."referrer_user_id" <> "referrals"."referred_user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country_code" char(2);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country_source" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN "referral_code" varchar(32);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_clicks" ADD CONSTRAINT "referral_clicks_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_points" ADD CONSTRAINT "referral_points_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_points" ADD CONSTRAINT "referral_points_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_users_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_users_id_fk" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_code_id_referral_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_click_id_referral_clicks_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."referral_clicks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_root_referrer_id_users_id_fk" FOREIGN KEY ("root_referrer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_countries_continent" ON "countries" USING btree ("continent");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referral_clicks_code_id" ON "referral_clicks" USING btree ("code_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referral_codes_code" ON "referral_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referral_points_user_id" ON "referral_points" USING btree ("user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_referral_points_referral_kind" ON "referral_points" USING btree ("referral_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_referral_points_circuit" ON "referral_points" USING btree ("user_id","season_id") WHERE "referral_points"."kind" = 'full_circuit';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referrals_referrer_user_id" ON "referrals" USING btree ("referrer_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referrals_root_referrer_id" ON "referrals" USING btree ("root_referrer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referrals_ancestor_path" ON "referrals" USING gin ("ancestor_path");