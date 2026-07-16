ALTER TABLE "books" ADD COLUMN "is_removed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_books_is_removed" ON "books" USING btree ("is_removed");