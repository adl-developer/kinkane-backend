-- Group search matches on the group's name only. The description was in the
-- full-text arm, so a query turned up every group that happened to mention the
-- word anywhere in its blurb — results with no visible connection to what was
-- typed. Rebuilding the generated column keeps the GIN index on it, which still
-- serves multi-word queries in any order ("club book" finds "Book Club").
ALTER TABLE "groups" ALTER COLUMN "search_vector" SET EXPRESSION AS (to_tsvector('simple', coalesce("name", '')));
