-- Bring `ingestion_chunks` into line with what onix_ingester actually writes.
--
-- The ingester moved chunk payloads out of Postgres and into R2, replacing the
-- inline `data` jsonb column with `data_key` pointing at the R2 object. It
-- shipped that change as its own SQL file — but migration ownership for these
-- tables belongs to the server, so the file never ran on deploy and every
-- ingestion run failed with `column "data_key" of relation "ingestion_chunks"
-- does not exist`, which is why the Gardners delta feed has not applied since
-- July 2026.
--
-- Both statements are idempotent because environments are in different states:
-- some databases were patched by hand after the failure and already have
-- `data_key` with `data` dropped, while others are still on the original shape.
-- IF NOT EXISTS / IF EXISTS makes this correct from either starting point.
--
-- Dropping `data` is safe: the current ingester never reads it, and any payload
-- still sitting in it belongs to a chunk that failed months ago and cannot be
-- resumed. Re-trigger the parent ingestion job to reprocess those files.
ALTER TABLE "ingestion_chunks" ADD COLUMN IF NOT EXISTS "data_key" varchar(500);--> statement-breakpoint
ALTER TABLE "ingestion_chunks" DROP COLUMN IF EXISTS "data";
