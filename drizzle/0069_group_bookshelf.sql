CREATE TYPE "public"."group_book_status" AS ENUM('want_to_read', 'currently_reading', 'finished');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_book_comment_likes" (
	"user_id" integer NOT NULL,
	"comment_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_book_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_book_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"parent_id" integer,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_books" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"status" "group_book_status" NOT NULL,
	"description" text,
	"started_on" date,
	"finished_on" date,
	"added_by" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_books_started_on_present" CHECK ("group_books"."status" <> 'currently_reading' OR "group_books"."started_on" IS NOT NULL),
	CONSTRAINT "group_books_finished_on_present" CHECK ("group_books"."status" <> 'finished' OR "group_books"."finished_on" IS NOT NULL),
	CONSTRAINT "group_books_date_order" CHECK ("group_books"."finished_on" >= "group_books"."started_on")
);
--> statement-breakpoint
ALTER TABLE "user_reports" ADD COLUMN "group_comment_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_book_comment_likes" ADD CONSTRAINT "group_book_comment_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_book_comment_likes" ADD CONSTRAINT "group_book_comment_likes_comment_id_group_book_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."group_book_comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_book_comments" ADD CONSTRAINT "group_book_comments_group_book_id_group_books_id_fk" FOREIGN KEY ("group_book_id") REFERENCES "public"."group_books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_book_comments" ADD CONSTRAINT "group_book_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_book_comments" ADD CONSTRAINT "group_book_comments_parent_id_group_book_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."group_book_comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_books" ADD CONSTRAINT "group_books_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_books" ADD CONSTRAINT "group_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_books" ADD CONSTRAINT "group_books_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_book_comment_likes_user_comment" ON "group_book_comment_likes" USING btree ("user_id","comment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_book_comment_likes_comment_id" ON "group_book_comment_likes" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_book_comments_thread" ON "group_book_comments" USING btree ("group_book_id","parent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_book_comments_parent" ON "group_book_comments" USING btree ("parent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_book_comments_user_id" ON "group_book_comments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_books_group_book" ON "group_books" USING btree ("group_id","book_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_books_one_current" ON "group_books" USING btree ("group_id") WHERE "group_books"."status" = 'currently_reading';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_books_group_status" ON "group_books" USING btree ("group_id","status","added_at" desc);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_group_comment_id_group_book_comments_id_fk" FOREIGN KEY ("group_comment_id") REFERENCES "public"."group_book_comments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_group_comment_id" ON "user_reports" USING btree ("group_comment_id");