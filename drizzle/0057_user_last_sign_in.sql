-- The admin console's "active customer" now means *seen in the last 12 months*
-- rather than *paid for something in the last 12 months*. Nothing in the schema
-- could answer that: `last_login_at` exists only on `admins`, and the obvious
-- proxy — `refresh_tokens.created_at` — cannot answer a one-year question,
-- because those rows carry a 30-day TTL and are deleted on logout, rotation,
-- password change and blacklist. A user last seen six months ago has no rows at
-- all, which is indistinguishable from one who has never signed in.
--
-- So the fact has to be stored. Staged rather than a single ADD COLUMN, because
-- the obvious one-liner (`ADD COLUMN ... DEFAULT now() NOT NULL`, which is what
-- drizzle-kit generates for this schema change) would stamp every existing
-- account as seen *today* and the console would read "100% active" on the first
-- load after deploy.
--
-- Backfilling to created_at is a deliberate fiction — we never recorded
-- sign-ins before now, so there is no true value to recover. The honest
-- alternative, leaving it null and treating null as inactive, reproduces the
-- exact bug this change was raised to fix: every customer reads inactive, for a
-- year, because the column is empty rather than because anyone is dormant.
-- Seeding from signup date means recent signups read active, genuinely dormant
-- old accounts read inactive, and the fiction decays out of the data on its own
-- as real activity overwrites it.
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;--> statement-breakpoint
UPDATE "users" SET "last_sign_in_at" = "created_at" WHERE "last_sign_in_at" IS NULL;--> statement-breakpoint
-- Only now is NOT NULL safe: the backfill covers every existing row and the
-- default covers every future one, so "never seen" is not a state a row can be
-- in and nothing downstream has to handle null.
ALTER TABLE "users" ALTER COLUMN "last_sign_in_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "last_sign_in_at" SET NOT NULL;--> statement-breakpoint
-- The Customers list and the Overview card both filter and count on this on
-- every load. Without an index each becomes a seq scan of the whole users table.
--
-- Mirrored CONCURRENTLY in src/db/build-concurrent-indexes.ts, which runs ahead
-- of this migration on every deploy — so from the second deploy onward the index
-- is already there and this statement's IF NOT EXISTS makes it a no-op. On the
-- deploy that first adds the column there is nothing for that step to index yet
-- and it skips by design, so this is the build that runs, under a SHARE lock.
-- That is the one deploy where sign-in writes can stall here.
CREATE INDEX IF NOT EXISTS "idx_users_last_sign_in_at" ON "users" USING btree ("last_sign_in_at");
