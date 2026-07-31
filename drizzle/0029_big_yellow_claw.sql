CREATE TABLE IF NOT EXISTS "user_disliked_books" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"title_normalized" varchar(2000) NOT NULL,
	"author_normalized" varchar(500),
	"source" varchar(50) DEFAULT 'app' NOT NULL,
	"dislike_count" integer DEFAULT 1 NOT NULL,
	"first_disliked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_disliked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN "disliked_book_ids" jsonb;--> statement-breakpoint
ALTER TABLE "user_preference_history" ADD COLUMN "disliked_book_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_disliked_books" ADD CONSTRAINT "user_disliked_books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_disliked_books" ADD CONSTRAINT "user_disliked_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_disliked_books_user" ON "user_disliked_books" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_disliked_books_user_book" ON "user_disliked_books" USING btree ("user_id","book_id");