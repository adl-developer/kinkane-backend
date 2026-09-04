ALTER TABLE "books" ADD COLUMN "main_genre_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "books" ADD CONSTRAINT "books_main_genre_id_genres_id_fk" FOREIGN KEY ("main_genre_id") REFERENCES "public"."genres"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_books_main_genre" ON "books" USING btree ("main_genre_id","updated_at") WHERE "books"."is_removed" = false;