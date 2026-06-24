CREATE TABLE IF NOT EXISTS "book_excerpts" (
	"id" serial PRIMARY KEY NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"title" varchar(2000),
	"url" varchar(500),
	"available" boolean DEFAULT true NOT NULL,
	"jb_updated_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_excerpts_isbn13_unique" UNIQUE("isbn13")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_excerpts_isbn13" ON "book_excerpts" USING btree ("isbn13");