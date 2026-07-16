ALTER TABLE "ingestion_chunks" DROP COLUMN "data";--> statement-breakpoint
ALTER TABLE "ingestion_chunks" ADD COLUMN "data_key" varchar(500);
