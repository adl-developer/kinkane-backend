CREATE TYPE "public"."chunk_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('pending', 'processing', 'enqueued', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" varchar(500) NOT NULL,
	"email" varchar(500) NOT NULL,
	"password_hash" varchar(500),
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_contributors" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"sequence_number" integer,
	"role" varchar(10),
	"person_name" varchar(500),
	"person_name_inverted" varchar(500)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_genres" (
	"book_id" integer NOT NULL,
	"genre_id" integer NOT NULL,
	CONSTRAINT "book_genres_book_id_genre_id_pk" PRIMARY KEY("book_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"price_type" varchar(2),
	"price_amount" numeric(12, 2),
	"currency_code" varchar(3),
	"tax_rate_code" varchar(2),
	"tax_rate_percent" numeric(6, 2)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_subjects" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"scheme_identifier" varchar(10),
	"scheme_version" varchar(10),
	"subject_code" varchar(50),
	"subject_heading_text" varchar(500),
	"is_main_subject" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "books" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_reference" varchar(100) NOT NULL,
	"isbn13" varchar(13),
	"notification_type" varchar(2),
	"product_form" varchar(10),
	"product_composition" varchar(2),
	"edition_number" integer,
	"page_count" integer,
	"height_mm" numeric(7, 2),
	"width_mm" numeric(7, 2),
	"thickness_mm" numeric(7, 2),
	"weight_gr" numeric(9, 2),
	"country_of_manufacture" varchar(2),
	"product_classification_code" varchar(30),
	"title" varchar(2000) NOT NULL,
	"subtitle" varchar(2000),
	"short_description" text,
	"long_description" text,
	"publisher_name" varchar(500),
	"imprint_name" varchar(500),
	"country_of_publication" varchar(2),
	"publishing_status" varchar(2),
	"publication_date" date,
	"availability_code" varchar(2),
	"returns_code" varchar(10),
	"order_time" integer,
	"search_vector" "tsvector",
	"embedding" vector(768),
	"embedded_at" timestamp with time zone,
	"cover_url" varchar(500),
	"cover_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_record_reference_unique" UNIQUE("record_reference"),
	CONSTRAINT "books_isbn13_unique" UNIQUE("isbn13")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "genres" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(300) NOT NULL,
	"slug" varchar(300) NOT NULL,
	"subject_code" varchar(50),
	"scheme_identifier" varchar(10),
	CONSTRAINT "genres_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingestion_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"status" "chunk_status" DEFAULT 'pending' NOT NULL,
	"book_count" integer,
	"processed_books" integer DEFAULT 0,
	"bull_job_id" varchar(200),
	"data" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingestion_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_key" varchar(1000) NOT NULL,
	"status" "ingestion_status" DEFAULT 'pending' NOT NULL,
	"total_chunks" integer,
	"processed_chunks" integer DEFAULT 0,
	"failed_chunks" integer DEFAULT 0,
	"total_books" integer,
	"processed_books" integer DEFAULT 0,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_contributors" ADD CONSTRAINT "book_contributors_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_genres" ADD CONSTRAINT "book_genres_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_genres" ADD CONSTRAINT "book_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_prices" ADD CONSTRAINT "book_prices_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_subjects" ADD CONSTRAINT "book_subjects_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ingestion_chunks" ADD CONSTRAINT "ingestion_chunks_job_id_ingestion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user_id" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_contributors_book_id" ON "book_contributors" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_genres_genre_id" ON "book_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_prices_book_id" ON "book_prices" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_subjects_book_id" ON "book_subjects" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_books_isbn13" ON "books" USING btree ("isbn13");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_books_title" ON "books" USING btree ("title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_books_publisher" ON "books" USING btree ("publisher_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_books_availability" ON "books" USING btree ("availability_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingestion_chunks_job_id" ON "ingestion_chunks" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingestion_jobs_file_key" ON "ingestion_jobs" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ingestion_jobs_status" ON "ingestion_jobs" USING btree ("status");