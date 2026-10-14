ALTER TABLE "user_preferences" ADD COLUMN "removed_book_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Remembers a book the reader removed from their shelf or saved list, so the
-- new-book notification never offers it as new. A trigger rather than code in
-- each service so every removal path (shelf edits, pruning an emptied row,
-- unsaving, anything added later) is covered. jsonb @> with a scalar tests
-- array membership, so a book removed twice is stored once.
CREATE OR REPLACE FUNCTION remember_removed_book() RETURNS trigger AS $$
BEGIN
  UPDATE user_preferences
  SET removed_book_ids = removed_book_ids || to_jsonb(OLD.book_id)
  WHERE user_id = OLD.user_id
    AND NOT removed_book_ids @> to_jsonb(OLD.book_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER user_books_remember_removed
  AFTER DELETE ON user_books
  FOR EACH ROW EXECUTE FUNCTION remember_removed_book();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER saved_books_remember_removed
  AFTER DELETE ON saved_books
  FOR EACH ROW EXECUTE FUNCTION remember_removed_book();
