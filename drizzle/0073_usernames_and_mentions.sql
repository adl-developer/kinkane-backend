CREATE TABLE IF NOT EXISTS "username_holds" (
	"username" varchar(20) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"mentioned_user_id" integer NOT NULL,
	"author_id" integer,
	"post_id" integer,
	"comment_id" integer,
	"group_id" integer,
	"group_book_id" integer,
	"group_comment_id" integer,
	"user_book_id" integer,
	"notified_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentions_one_source" CHECK (num_nonnulls("mentions"."post_id", "mentions"."comment_id", "mentions"."group_id", "mentions"."group_book_id", "mentions"."group_comment_id", "mentions"."user_book_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "mentions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "username_holds" ADD CONSTRAINT "username_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_group_book_id_group_books_id_fk" FOREIGN KEY ("group_book_id") REFERENCES "public"."group_books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_group_comment_id_group_book_comments_id_fk" FOREIGN KEY ("group_comment_id") REFERENCES "public"."group_book_comments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mentions" ADD CONSTRAINT "mentions_user_book_id_user_books_id_fk" FOREIGN KEY ("user_book_id") REFERENCES "public"."user_books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mentions_post_user" ON "mentions" USING btree ("post_id","mentioned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mentions_comment_user" ON "mentions" USING btree ("comment_id","mentioned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mentions_group_user" ON "mentions" USING btree ("group_id","mentioned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mentions_group_book_user" ON "mentions" USING btree ("group_book_id","mentioned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mentions_group_comment_user" ON "mentions" USING btree ("group_comment_id","mentioned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mentions_user_book_user" ON "mentions" USING btree ("user_book_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mentions_mentioned_created" ON "mentions" USING btree ("mentioned_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_username" ON "users" USING btree ("username");