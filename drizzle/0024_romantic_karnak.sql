CREATE TYPE "public"."gardners_dropship_line_status" AS ENUM('pending', 'fulfilled', 'partial', 'backordered', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."gardners_dropship_order_status" AS ENUM('pending_submission', 'submitted', 'acknowledged', 'rejected', 'submission_failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_dropship_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"additional_reference" varchar(15) NOT NULL,
	"quantity" integer NOT NULL,
	"price_gbp_pence" integer NOT NULL,
	"delivery_gbp_pence" integer DEFAULT 0 NOT NULL,
	"service_code" varchar(3) NOT NULL,
	"tracking" boolean DEFAULT true NOT NULL,
	"tracking_email" varchar(254) NOT NULL,
	"tracking_sms" varchar(20),
	"tracking_safe_place" varchar(24),
	"batch_ref" varchar(15),
	"max_wait_days" integer DEFAULT 7 NOT NULL,
	"comm1" varchar(60),
	"invoice_title_name" varchar(10),
	"invoice_initials" varchar(3),
	"invoice_name" varchar(35) NOT NULL,
	"invoice_addr1" varchar(35) NOT NULL,
	"invoice_addr2" varchar(35),
	"invoice_addr3" varchar(35),
	"invoice_addr4" varchar(35),
	"invoice_postcode" varchar(8),
	"invoice_country" varchar(60) NOT NULL,
	"delivery_title_name" varchar(10),
	"delivery_initials" varchar(3),
	"delivery_name" varchar(35),
	"delivery_addr1" varchar(35),
	"delivery_addr2" varchar(35),
	"delivery_addr3" varchar(35),
	"delivery_addr4" varchar(35),
	"delivery_postcode" varchar(8),
	"delivery_country" varchar(60),
	"status" "gardners_dropship_line_status" DEFAULT 'pending' NOT NULL,
	"gardners_ref" varchar(20),
	"quantity_supplied" integer,
	"report_code" varchar(10),
	"report_date" date,
	"line_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gardners_dropship_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_stem" varchar(15) NOT NULL,
	"account_code" varchar(6) NOT NULL,
	"testing" boolean DEFAULT true NOT NULL,
	"order_date" date NOT NULL,
	"status" "gardners_dropship_order_status" DEFAULT 'pending_submission' NOT NULL,
	"remote_ord_path" varchar(500),
	"remote_ack_path" varchar(500),
	"raw_ack" text,
	"header_error_message" text,
	"submitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gardners_dropship_orders_file_stem_unique" UNIQUE("file_stem")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gardners_dropship_order_lines" ADD CONSTRAINT "gardners_dropship_order_lines_order_id_gardners_dropship_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."gardners_dropship_orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_dropship_order_lines_order_id" ON "gardners_dropship_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_dropship_order_lines_isbn13" ON "gardners_dropship_order_lines" USING btree ("isbn13");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_dropship_orders_status" ON "gardners_dropship_orders" USING btree ("status");