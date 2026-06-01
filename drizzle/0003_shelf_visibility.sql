CREATE TYPE "shelf_visibility" AS ENUM ('public', 'friends', 'private');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "shelf_visibility" "shelf_visibility" NOT NULL DEFAULT 'private';
