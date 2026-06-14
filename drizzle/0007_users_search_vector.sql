ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

-- Trigger function: rebuilds search_vector on every insert/update
CREATE OR REPLACE FUNCTION users_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', COALESCE(NEW.name, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER users_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name ON users
  FOR EACH ROW EXECUTE FUNCTION users_search_vector_update();

-- Backfill existing rows
UPDATE "users" SET "search_vector" = to_tsvector('simple', COALESCE("name", ''));

-- GIN index for fast FTS lookups
CREATE INDEX IF NOT EXISTS "idx_users_search_vector" ON "users" USING GIN("search_vector");
