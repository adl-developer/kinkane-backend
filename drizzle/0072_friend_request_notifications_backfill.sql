-- 0071 started writing a friend_request notification for every new follow
-- request; this gives every older request one too, so the feed can switch
-- from its live view over follow_requests to stored rows without any request
-- going missing. Pending requests stay unread (the live view counted them);
-- accepted/declined ones are marked read as of when they were resolved, since
-- the live view never counted those. ON CONFLICT skips requests 0071 already
-- covered, and makes a re-run harmless.
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
