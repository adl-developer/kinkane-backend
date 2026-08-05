ALTER TABLE "notification_preferences" ADD COLUMN "marketing_emails" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Backfill for users who already clicked the old one-click unsubscribe.
--
-- The old route set exactly these three flags false together, so all-three-false
-- is the signature of a past unsubscribe. Those users get:
--   * marketing_emails = false — their unsubscribe now also covers the
--     newsletter, which was previously ungated entirely. Without this line a
--     past unsubscribe would silently stop covering everything it used to.
--   * friend_requests  = true  — follow requests are no longer part of what
--     unsubscribe turns off, so an old unsubscribe should stop suppressing them.
--
-- Caveat, accepted deliberately: a user who turned all three off by hand in
-- settings is indistinguishable from one who clicked unsubscribe, and will have
-- follow-request email re-enabled. Rare, reversible from settings, and the
-- alternative (leaving them off) permanently misapplies the old rule to the new
-- one for everyone who actually did unsubscribe.
UPDATE "notification_preferences"
SET "marketing_emails" = false,
    "friend_requests"  = true,
    "updated_at"       = now()
WHERE "new_book_suggestions"  = false
  AND "rate_review_reminders" = false
  AND "friend_requests"       = false;
