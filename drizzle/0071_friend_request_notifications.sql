ALTER TABLE "notifications" ADD COLUMN "follow_request_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_follow_request_id_follow_requests_id_fk" FOREIGN KEY ("follow_request_id") REFERENCES "public"."follow_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_notifications_follow_request_id" ON "notifications" USING btree ("follow_request_id");--> statement-breakpoint
-- Friend requests used to be a live view over follow_requests; give every
-- existing request its stored notification so the feed looks the same after
-- the switch. Pending requests stay unread (the old unread count included
-- them); accepted/declined ones are marked read as of when they were resolved,
-- since the old count never included those.
INSERT INTO "notifications" ("user_id", "type", "data", "follow_request_id", "read_at", "created_at")
SELECT
  fr."receiver_id",
  'friend_request',
  jsonb_build_object(
    'followRequestId', fr."id",
    'senderId', fr."sender_id",
    'senderName', u."name",
    'senderPhotoUrl', u."photo_url",
    'status', fr."status"::text
  ),
  fr."id",
  CASE WHEN fr."status" = 'pending' THEN NULL ELSE fr."updated_at" END,
  fr."created_at"
FROM "follow_requests" fr
JOIN "users" u ON u."id" = fr."sender_id"
ON CONFLICT ("follow_request_id") DO NOTHING;
