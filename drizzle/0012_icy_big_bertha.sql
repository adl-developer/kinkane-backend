ALTER TABLE "user_books" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_books" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_books" ADD COLUMN "liked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_books" ADD COLUMN "liked_at" timestamp with time zone;