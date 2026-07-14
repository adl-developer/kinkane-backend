CREATE TYPE "public"."gardners_feed" AS ENUM('inventory', 'biblio_delta', 'biblio_full', 'avail13', 'promotions', 'firm_sale', 'isbn_slips', 'market_restrictions', 'regions', 'covers_full', 'covers_update', 'covers_instock');--> statement-breakpoint
CREATE TYPE "public"."gardners_fetch_status" AS ENUM('downloading', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_fetch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"feed" "gardners_feed" NOT NULL,
	"remote_path" varchar(1000) NOT NULL,
	"remote_filename" varchar(500) NOT NULL,
	"remote_modified_at" timestamp with time zone,
	"remote_size" integer,
	"r2_key" varchar(500),
	"status" "gardners_fetch_status" DEFAULT 'downloading' NOT NULL,
	"total_chunks" integer,
	"processed_chunks" integer DEFAULT 0,
	"row_count" integer,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"book_id" integer,
	"rrp_gbp" numeric(10, 2),
	"discount_percent" numeric(5, 2),
	"stock_qty" integer,
	"report_code" varchar(10),
	"report_date" date,
	"source" varchar(20) NOT NULL,
	"source_file_key" varchar(500),
	"stock_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_promotions" (
	"id" serial PRIMARY KEY NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"book_id" integer,
	"title" varchar(2000),
	"author" varchar(500),
	"price" numeric(10, 2),
	"discount_percent" numeric(5, 2),
	"returns_flag" varchar(1),
	"finish_date" date,
	"source_file_key" varchar(500),
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_firm_sale" (
	"isbn13" varchar(13) PRIMARY KEY NOT NULL,
	"book_id" integer,
	"report_code" varchar(10),
	"source_file_key" varchar(500),
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_isbn_slips" (
	"old_isbn13" varchar(13) PRIMARY KEY NOT NULL,
	"new_isbn13" varchar(13) NOT NULL,
	"source_file_key" varchar(500),
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_market_restrictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"book_id" integer,
	"flag" varchar(1) NOT NULL,
	"region_code" varchar(10) NOT NULL,
	"source_file_key" varchar(500),
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_regions" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gardners_stock" ADD CONSTRAINT "gardners_stock_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gardners_promotions" ADD CONSTRAINT "gardners_promotions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gardners_firm_sale" ADD CONSTRAINT "gardners_firm_sale_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gardners_market_restrictions" ADD CONSTRAINT "gardners_market_restrictions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_gardners_fetch_log_feed_remote_path" ON "gardners_fetch_log" USING btree ("feed","remote_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_fetch_log_feed_status" ON "gardners_fetch_log" USING btree ("feed","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_gardners_stock_isbn13" ON "gardners_stock" USING btree ("isbn13");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_stock_book_id" ON "gardners_stock" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_stock_updated_at" ON "gardners_stock" USING btree ("stock_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_gardners_promotions_isbn13" ON "gardners_promotions" USING btree ("isbn13");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_promotions_book_id" ON "gardners_promotions" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_promotions_finish_date" ON "gardners_promotions" USING btree ("finish_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_firm_sale_book_id" ON "gardners_firm_sale" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_isbn_slips_new_isbn" ON "gardners_isbn_slips" USING btree ("new_isbn13");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_market_restrictions_isbn" ON "gardners_market_restrictions" USING btree ("isbn13");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_gardners_market_restrictions_isbn_region" ON "gardners_market_restrictions" USING btree ("isbn13","region_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_market_restrictions_book_id" ON "gardners_market_restrictions" USING btree ("book_id");