ALTER TABLE "orders" ALTER COLUMN "shipping_rule" SET DATA TYPE varchar(40);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_service_code" varchar(3);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_weight_g" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_weight_estimated" boolean DEFAULT false NOT NULL;