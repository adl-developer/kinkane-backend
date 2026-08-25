CREATE TABLE IF NOT EXISTS "contact_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"name" varchar(200) NOT NULL,
	"email" varchar(254) NOT NULL,
	"subject" varchar(200) NOT NULL,
	"message" text NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_messages_created_at" ON "contact_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_messages_email" ON "contact_messages" USING btree ("email");