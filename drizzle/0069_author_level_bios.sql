CREATE TABLE IF NOT EXISTS "author_bios" (
	"normalised_name" varchar(500) PRIMARY KEY NOT NULL,
	"display_name" varchar(500) NOT NULL,
	"bio_html" text NOT NULL,
	"source_isbn13" varchar(13),
	"source_pub_date" date,
	"source_updated" varchar(8),
	"confidence" varchar(16) DEFAULT 'high' NOT NULL,
	"books_considered" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_author_bios_confidence" ON "author_bios" USING btree ("confidence");