CREATE TABLE IF NOT EXISTS "referral_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"channel" varchar(20) NOT NULL,
	"recipient_hash" varchar(64),
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "credited_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_invites" ADD CONSTRAINT "referral_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referral_invites_user_id" ON "referral_invites" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_referral_invites_recipient" ON "referral_invites" USING btree ("user_id","recipient_hash") WHERE "referral_invites"."recipient_hash" is not null;--> statement-breakpoint
-- Grandfather every referral that predates the verification gate.
--
-- Under the old rule points were written at signup, so each of these rows has
-- already paid its referrer. Leaving credited_at null would strand them as
-- "Pending" on the referral screen for ever — the points would still be in the
-- ledger, but the funnel would say they were never earned, and creditVerifiedSignup
-- would try to pay them a second time the moment those readers verified.
--
-- signed_up_at rather than now(), so the timestamp stays truthful about when
-- the credit was actually made.
UPDATE "referrals" SET "credited_at" = "signed_up_at" WHERE "credited_at" IS NULL;
