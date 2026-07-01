CREATE TABLE IF NOT EXISTS "recommendation_email_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "last_recommendation_sent_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recommendation_email_log" ADD CONSTRAINT "recommendation_email_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "recommendation_email_log" ADD CONSTRAINT "recommendation_email_log_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_rec_email_log_user_book" ON "recommendation_email_log" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_notif_prefs_last_rec_sent" ON "notification_preferences" USING btree ("last_recommendation_sent_at");