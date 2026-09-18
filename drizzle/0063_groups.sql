CREATE TYPE "public"."group_membership_status" AS ENUM('invited', 'requested', 'active');--> statement-breakpoint
CREATE TYPE "public"."group_privacy" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"status" "group_membership_status" NOT NULL,
	"invited_by" integer,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_memberships_joined_at_consistency" CHECK (("group_memberships"."status" = 'active') = ("group_memberships"."joined_at" IS NOT NULL)),
	CONSTRAINT "group_memberships_invited_by_direction" CHECK ("group_memberships"."status" <> 'requested' OR "group_memberships"."invited_by" IS NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"photo_url" varchar(500),
	"privacy" "group_privacy" DEFAULT 'public' NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_member_count_non_negative" CHECK ("groups"."member_count" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_group_memberships_group_user" ON "group_memberships" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_memberships_user_status" ON "group_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_memberships_group_status" ON "group_memberships" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_groups_owner_id" ON "groups" USING btree ("owner_id");--> statement-breakpoint
-- Hand-added below: drizzle-kit cannot emit GENERATED ALWAYS columns, USING GIN,
-- or gin_trgm_ops, all three of which group search depends on.
--
-- search_vector is generated rather than trigger-maintained (the pattern books
-- uses) because there is no backfill to do and nothing ever writes it from the
-- app -- a generated column cannot drift out of sync with name/description.
-- 'simple' rather than 'english': group names are names, so stemming them would
-- match "Reader" to "Reading". Same reasoning as users.search_vector.
ALTER TABLE "groups" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("description", '')), 'B')
  ) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_groups_search_vector" ON "groups" USING GIN ("search_vector");--> statement-breakpoint
-- Backs word_similarity(q, name) in the search ranking. Without it that tier is
-- a sequential scan over every group.
CREATE INDEX IF NOT EXISTS "idx_groups_name_trgm" ON "groups" USING GIN ("name" gin_trgm_ops);
