CREATE TABLE IF NOT EXISTS "email_change_requests" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "new_email" varchar(500) NOT NULL,
  "otp_hash" varchar(64) NOT NULL,
  "cancel_token_hash" varchar(64) NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_email_change_requests_user_id" ON "email_change_requests" ("user_id");
