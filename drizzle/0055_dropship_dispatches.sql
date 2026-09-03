CREATE TABLE IF NOT EXISTS "gardners_dropship_dispatches" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_line_id" integer NOT NULL,
	"dispatch_no" varchar(20) NOT NULL,
	"isbn13" varchar(13) NOT NULL,
	"quantity" integer NOT NULL,
	"dispatched_on" date,
	"price_pence" integer,
	"delivery_pence" integer,
	"discount_basis_points" integer,
	"carrier" varchar(100),
	"tracking_number" varchar(100),
	"tracking_url" varchar(500),
	"raw_detail" text,
	"source_file" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gardners_dropship_dispatches" ADD CONSTRAINT "gardners_dropship_dispatches_order_line_id_gardners_dropship_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."gardners_dropship_order_lines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gardners_dropship_dispatches_line" ON "gardners_dropship_dispatches" USING btree ("order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_gardners_dropship_dispatch_line" ON "gardners_dropship_dispatches" USING btree ("dispatch_no","order_line_id");