CREATE TYPE "public"."reader_type" AS ENUM('The Open Door', 'The Seeker', 'The Book-ist', 'The Story Circler', 'The Mirror Within', 'The Echo Collector', 'The High Summiter', 'The Cloud Illusionist');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reader_type" "reader_type";--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD COLUMN "reader_type" "reader_type";