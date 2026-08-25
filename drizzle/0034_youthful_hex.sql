CREATE TYPE "public"."cart_status" AS ENUM('active', 'converted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'payment_failed', 'expired', 'paid', 'submitted_to_supplier', 'acknowledged', 'supplier_rejected', 'dispatched', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cart_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"cart_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_gbp_pence" integer NOT NULL,
	"price_captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "carts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_gbp_pence" integer NOT NULL,
	"line_total_gbp_pence" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"line_total_minor" integer NOT NULL,
	"title_snapshot" varchar(500) NOT NULL,
	"contributor_snapshot" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"subtotal_gbp_pence" integer NOT NULL,
	"shipping_gbp_pence" integer DEFAULT 0 NOT NULL,
	"tax_gbp_pence" integer DEFAULT 0 NOT NULL,
	"total_gbp_pence" integer NOT NULL,
	"presentment_currency" varchar(3) NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"shipping_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"fx_rate" numeric(18, 8) NOT NULL,
	"fx_captured_at" timestamp with time zone NOT NULL,
	"tax_rate_percent" numeric(6, 3) DEFAULT '0' NOT NULL,
	"tax_source" varchar(20) DEFAULT 'env' NOT NULL,
	"shipping_rule" varchar(20),
	"stripe_checkout_session_id" varchar(255),
	"stripe_payment_intent_id" varchar(255),
	"contact_email" varchar(254) NOT NULL,
	"shipping_name" varchar(200),
	"shipping_line1" varchar(200),
	"shipping_line2" varchar(200),
	"shipping_city" varchar(200),
	"shipping_region" varchar(200),
	"shipping_postcode" varchar(32),
	"shipping_country_code" varchar(2) NOT NULL,
	"gardners_dropship_order_id" integer,
	"fulfilment_error_message" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_stripe_checkout_session_id_unique" UNIQUE("stripe_checkout_session_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_gardners_dropship_order_id_gardners_dropship_orders_id_fk" FOREIGN KEY ("gardners_dropship_order_id") REFERENCES "public"."gardners_dropship_orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cart_items_cart_id" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cart_items_cart_book" ON "cart_items" USING btree ("cart_id","book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_carts_user_id" ON "carts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_carts_active_user" ON "carts" USING btree ("user_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_items_order_id" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_items_book_id" ON "order_items" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_order_items_bestseller" ON "order_items" USING btree ("created_at","book_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_user_id" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_orders_created_at" ON "orders" USING btree ("created_at");