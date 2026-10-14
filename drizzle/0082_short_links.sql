-- Web addresses written into posts, comments and other user text, each with the
-- short code it is shown as (APP_URL/l/<code>). One row per address so a block
-- covers every post that carries it.
CREATE TABLE IF NOT EXISTS "short_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(16) NOT NULL,
	"url" text NOT NULL,
	"created_by" integer,
	"click_count" integer DEFAULT 0 NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "short_links" ADD CONSTRAINT "short_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_short_links_code" ON "short_links" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_short_links_url" ON "short_links" USING btree ("url");