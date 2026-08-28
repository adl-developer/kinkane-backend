ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_rating_check";--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_rating_check" CHECK ("posts"."rating" BETWEEN 0 AND 5);
