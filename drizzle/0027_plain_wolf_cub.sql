CREATE TABLE IF NOT EXISTS "user_preference_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"feelings" jsonb NOT NULL,
	"book_ids" jsonb NOT NULL,
	"genres" jsonb NOT NULL,
	"dislikes" jsonb NOT NULL,
	"reader_type" "reader_type",
	"changed_fields" jsonb NOT NULL,
	"source" varchar(50) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_preference_history" ADD CONSTRAINT "user_preference_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_pref_history_user_recorded" ON "user_preference_history" USING btree ("user_id","recorded_at");--> statement-breakpoint
-- Baseline backfill: give every existing user one history row reflecting their
-- current preferences, so nobody starts with an empty timeline. Real history
-- begins from here — prior changes were overwritten in place and are gone.
--
-- recorded_at is taken from user_preferences.updated_at rather than now(), so
-- the baseline is dated when the user actually last set their preferences.
-- source is 'onboarding' because that is the only way these rows could have
-- originated before this table existed.
INSERT INTO "user_preference_history"
  ("user_id", "feelings", "book_ids", "genres", "dislikes", "reader_type", "changed_fields", "source", "recorded_at")
SELECT
  up."user_id",
  up."feelings",
  up."book_ids",
  up."genres",
  up."dislikes",
  u."reader_type",
  '[]'::jsonb,
  'onboarding',
  up."updated_at"
FROM "user_preferences" up
JOIN "users" u ON u."id" = up."user_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "user_preference_history" h WHERE h."user_id" = up."user_id"
);