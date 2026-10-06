ALTER TABLE "notifications" ADD COLUMN "follow_request_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_follow_request_id_follow_requests_id_fk" FOREIGN KEY ("follow_request_id") REFERENCES "public"."follow_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_follow_request_id" ON "notifications" USING btree ("follow_request_id");
