CREATE TYPE "post_status" AS ENUM ('reading_now', 'finished_reading');

ALTER TABLE "posts"
  ADD COLUMN "status" post_status NOT NULL DEFAULT 'finished_reading';

-- Remove the temporary default — new rows must supply status explicitly.
ALTER TABLE "posts" ALTER COLUMN "status" DROP DEFAULT;
