CREATE TABLE IF NOT EXISTS "book_author_bios" (
	"id" serial PRIMARY KEY NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"bio_html" text,
	"source_field" varchar(32),
	"source_updated" varchar(8),
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_author_bios_isbn13_unique" UNIQUE("isbn13")
);
--> statement-breakpoint
ALTER TABLE "book_reviews" DROP CONSTRAINT "book_reviews_isbn13_unique";--> statement-breakpoint
ALTER TABLE "book_reviews" ADD COLUMN "source" varchar(16) DEFAULT 'nielsen' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_author_bios_checked_at" ON "book_author_bios" USING btree ("checked_at");--> statement-breakpoint
ALTER TABLE "book_reviews" ADD CONSTRAINT "book_reviews_isbn13_source_unique" UNIQUE("isbn13","source");