CREATE TYPE "follow_request_status" AS ENUM ('pending', 'accepted', 'declined');

CREATE TABLE IF NOT EXISTS "follow_requests" (
  "id"          serial PRIMARY KEY,
  "sender_id"   integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "receiver_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status"      follow_request_status NOT NULL DEFAULT 'pending',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "idx_follow_requests_sender_receiver" ON "follow_requests" ("sender_id", "receiver_id");
CREATE        INDEX "idx_follow_requests_receiver_id"      ON "follow_requests" ("receiver_id");
CREATE        INDEX "idx_follow_requests_sender_id"        ON "follow_requests" ("sender_id");
