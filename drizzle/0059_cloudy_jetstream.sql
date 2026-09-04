-- The customer-facing tracking code: eight Crockford base32 characters that a
-- guest (or a signed-in customer who would rather type than log in) pairs with
-- their contact email to look an order up.
--
-- Three statements rather than the one drizzle-kit generates, because a plain
-- `ADD COLUMN ... NOT NULL UNIQUE` cannot work on a table that already has
-- orders in it: every existing row would need the same absent value. So the
-- column arrives nullable, every existing order is given a code, and only then
-- is it constrained.
ALTER TABLE "orders" ADD COLUMN "tracking_code" varchar(16);--> statement-breakpoint

-- Backfill. Codes must be unique, and random generation can collide, so each
-- row is retried until it lands on a free code rather than assuming it will not.
--
-- The alphabet is Crockford base32 with I, L, O and U removed, and it is
-- duplicated here rather than imported from `order-identity.ts` — a migration
-- is a historical record that has to keep producing the same result years from
-- now, so it cannot depend on application code that will keep changing.
--
-- `gen_random_bytes` is not used: pgcrypto may not be installed, and these are
-- backfilled codes for orders that have already been delivered. `random()` is
-- adequate for uniqueness, which is all this loop needs — every code issued
-- from here on comes from `crypto.randomBytes` in the application.
DO $$
DECLARE
  alphabet CONSTANT text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  target record;
  candidate text;
  attempt int;
BEGIN
  FOR target IN SELECT id FROM orders WHERE tracking_code IS NULL LOOP
    attempt := 0;
    LOOP
      candidate := '';
      FOR i IN 1..8 LOOP
        candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
      END LOOP;

      EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE tracking_code = candidate);

      attempt := attempt + 1;
      IF attempt > 100 THEN
        RAISE EXCEPTION 'Could not find a free tracking code for order %', target.id;
      END IF;
    END LOOP;

    UPDATE orders SET tracking_code = candidate WHERE id = target.id;
  END LOOP;
END $$;--> statement-breakpoint

ALTER TABLE "orders" ALTER COLUMN "tracking_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tracking_code_unique" UNIQUE("tracking_code");
