ALTER TABLE "user_books" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "user_books" ADD COLUMN "note_is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_books_book_id" ON "user_books" USING btree ("book_id");