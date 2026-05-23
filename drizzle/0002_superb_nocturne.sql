CREATE TABLE IF NOT EXISTS "recommendation_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"results" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recommendation_cache_input_hash_unique" UNIQUE("input_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rec_cache_input_hash" ON "recommendation_cache" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rec_cache_expires_at" ON "recommendation_cache" USING btree ("expires_at");