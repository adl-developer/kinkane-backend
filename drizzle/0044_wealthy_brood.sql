-- Hand-edited after generation. `contact_email_normalized` is NOT NULL in the
-- schema, and drizzle-kit emits a bare `ADD COLUMN ... NOT NULL`, which fails
-- outright on a table that already has rows. Added nullable, backfilled, then
-- constrained.
--
-- The backfill below mirrors normalizeEmailForPromotions in lib/email-identity.
-- The two have to agree: a row backfilled differently from how a new row is
-- written is a buyer who silently qualifies for a second "first order" discount.
ALTER TABLE "orders" ADD COLUMN "contact_email_normalized" varchar(254);--> statement-breakpoint

-- Step 1: lower-case, and strip a +tag when something precedes it. A local part
-- that is nothing but a tag would normalise to empty and collide with every
-- other such address, so it keeps its local part.
UPDATE "orders" SET "contact_email_normalized" =
  CASE
    WHEN position('+' in split_part(lower("contact_email"), '@', 1)) > 1
      THEN split_part(split_part(lower("contact_email"), '@', 1), '+', 1)
    ELSE split_part(lower("contact_email"), '@', 1)
  END
  || '@' || split_part(lower("contact_email"), '@', 2);--> statement-breakpoint

-- Step 2: dots are only insignificant at the providers that ignore them.
UPDATE "orders"
SET "contact_email_normalized" =
  replace(split_part("contact_email_normalized", '@', 1), '.', '')
  || '@' || split_part("contact_email_normalized", '@', 2)
WHERE split_part("contact_email_normalized", '@', 2) IN ('gmail.com', 'googlemail.com');--> statement-breakpoint

-- Any address so malformed that the above produced nothing falls back to the
-- lower-cased original, which is what the TypeScript normaliser does too.
UPDATE "orders"
SET "contact_email_normalized" = lower("contact_email")
WHERE "contact_email_normalized" IS NULL
   OR "contact_email_normalized" = '@'
   OR "contact_email_normalized" = '';--> statement-breakpoint

ALTER TABLE "orders" ALTER COLUMN "contact_email_normalized" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_gbp_pence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_reason" varchar(40);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_contact_email_normalized" ON "orders" USING btree ("contact_email_normalized");
