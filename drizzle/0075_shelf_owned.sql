ALTER TABLE "user_books" ADD COLUMN "owned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_books" ADD COLUMN "owned_at" timestamp with time zone;