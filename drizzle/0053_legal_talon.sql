CREATE TYPE "public"."parcel_kind" AS ENUM('large_letter', 'parcel');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipping_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_code" char(3) NOT NULL,
	"country_code" char(2) NOT NULL,
	"parcel_kind" "parcel_kind" NOT NULL,
	"max_weight_g" integer NOT NULL,
	"price_pence" integer NOT NULL,
	"peak_price_pence" integer,
	"effective_from" date NOT NULL,
	"source" varchar(60) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_shipping_rates_lookup" ON "shipping_rates" USING btree ("service_code","country_code","parcel_kind","max_weight_g","effective_from");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shipping_rates_destination" ON "shipping_rates" USING btree ("country_code","service_code","effective_from");