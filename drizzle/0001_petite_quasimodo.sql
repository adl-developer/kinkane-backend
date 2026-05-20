CREATE TABLE IF NOT EXISTS "user_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"provider_uid" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "photo_url" varchar(1000);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_providers" ADD CONSTRAINT "user_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_providers_provider_uid" ON "user_providers" USING btree ("provider","provider_uid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_providers_user_id" ON "user_providers" USING btree ("user_id");