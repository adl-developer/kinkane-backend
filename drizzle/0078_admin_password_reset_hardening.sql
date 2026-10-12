DROP INDEX IF EXISTS "idx_admin_password_reset_tokens_admin_id";--> statement-breakpoint
ALTER TABLE "admins" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_admin_password_reset_tokens_admin_id" ON "admin_password_reset_tokens" USING btree ("admin_id");