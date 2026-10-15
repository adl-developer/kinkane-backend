-- One definition of "post text as search sees it", used by both generated
-- columns from 0084 AND by every query against them, so the stored side and the
-- typed side can never be cleaned differently.
--
-- Why 0084's expression was not enough: the database is ctype C, and in ctype C
-- the text-search parser treats every non-ASCII character as a letter. Curly
-- apostrophes, em dashes, ellipses and emoji — what a phone keyboard types —
-- were glued onto the words beside them ("tolkien’s", "world—truly"), so word
-- and phrase search missed them. Here, under ICU so the classes know non-ASCII:
--
--   1. NFC, so a decomposed "é" is one letter, not "e" plus a stray mark;
--   2. lowercase (ctype C's lower() leaves "É" alone);
--   3. blank out stored @mention (@{{u:123}}) and link ({{l:123}}) tokens —
--      kept character-identical to TOKEN_RE in mention-text.ts and link-text.ts
--      (with \d as [0-9]), which post-search-text.test.ts checks;
--   4. everything that is not a letter, digit or space becomes a space, which
--      also leaves no LIKE metacharacter (% _ \) in a cleaned query;
--   5. runs of space collapse to one, trimmed.
--
-- Changing this function does not rewrite stored rows: follow any change with
-- ALTER TABLE posts ALTER COLUMN … SET EXPRESSION, as below.
CREATE OR REPLACE FUNCTION post_search_text(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN btrim(regexp_replace(
  regexp_replace(
    regexp_replace(
      lower(normalize(t, NFC) COLLATE "und-x-icu"),
      '@\{\{u:([0-9]+)\}\}|\{\{l:([0-9]+)\}\}', ' ', 'g'),
    '[^[:alnum:][:space:]]', ' ', 'g'),
  '[[:space:]]+', ' ', 'g'));--> statement-breakpoint
-- SET EXPRESSION (Postgres 17+) rewrites the column and rebuilds its index.
ALTER TABLE "posts" ALTER COLUMN "search_text" SET EXPRESSION AS (post_search_text(coalesce("body", '')));--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "search_vector" SET EXPRESSION AS (to_tsvector('english', post_search_text(coalesce("body", ''))));
