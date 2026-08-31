ALTER TABLE "users" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city_lat" double precision;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city_lng" double precision;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city_source" varchar(20);--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "referrer_city" varchar(100);--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "redeemer_city" varchar(100);