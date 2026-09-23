CREATE TABLE IF NOT EXISTS "book_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"review_html" text,
	"source_field" varchar(16),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_reviews_isbn13_unique" UNIQUE("isbn13")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nielsen_api_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"batch_used" integer DEFAULT 0 NOT NULL,
	"on_demand_used" integer DEFAULT 0 NOT NULL,
	"limit_hit_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_reviews_checked_at" ON "book_reviews" USING btree ("checked_at");