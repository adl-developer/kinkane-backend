ALTER TYPE "public"."order_status" ADD VALUE 'delivered' BEFORE 'refunded';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "book_promotions" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"sale_price_gbp_pence" integer NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_book_promotions_price_positive" CHECK ("book_promotions"."sale_price_gbp_pence" > 0),
	CONSTRAINT "ck_book_promotions_window_ordered" CHECK ("book_promotions"."ends_at" IS NULL OR "book_promotions"."ends_at" > "book_promotions"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "reference" varchar(32);--> statement-breakpoint
-- Backfill before the NOT NULL: `orders` is a live table, so adding a NOT NULL
-- column outright would fail on every existing row. md5() is keyed on `id` as
-- well as random() so the expression is correlated per row — an uncorrelated
-- subquery would be evaluated once and hand every order the same reference,
-- which the unique constraint below would then reject. Hex uppercases into
-- 0-9A-F, all valid symbols in the application's reference alphabet, so
-- backfilled references are indistinguishable in shape from generated ones.
UPDATE "orders" SET "reference" = 'ORD-' || upper(substr(md5(random()::text || "id"::text), 1, 8)) WHERE "reference" IS NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "guest_access_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cart_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "carrier" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_number" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_url" varchar(500);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "book_promotions" ADD CONSTRAINT "book_promotions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_book_promotions_book_window" ON "book_promotions" USING btree ("book_id","starts_at","ends_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reference_unique" UNIQUE("reference");