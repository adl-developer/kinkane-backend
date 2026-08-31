ALTER TABLE "referrals" ADD COLUMN "grand_referrer_country" char(2);--> statement-breakpoint
-- Backfill the snapshot for referrals that have not been credited yet.
--
-- Only uncredited rows matter: a credited referral has already been paid, and
-- this column is read exactly once, at crediting. Leaving them null keeps the
-- column honest about what was actually snapshotted at signup.
--
-- Without this, any referral sitting in "pending" when this migration lands
-- would credit with a null grandparent country and silently pay no
-- second-degree award — the exact class of quiet under-scoring this column was
-- added to prevent.
--
-- ancestor_path is root-first and ends at the direct referrer, so the
-- second-degree earner is the second-to-last entry. Postgres arrays are
-- 1-indexed, hence array_length - 1.
UPDATE "referrals" r
SET "grand_referrer_country" = u."country_code"
FROM "users" u
WHERE r."credited_at" IS NULL
  AND array_length(r."ancestor_path", 1) >= 2
  AND u."id" = r."ancestor_path"[array_length(r."ancestor_path", 1) - 1];
