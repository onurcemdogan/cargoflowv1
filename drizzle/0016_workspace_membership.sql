CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_role_check" CHECK ("organization_members"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
DROP INDEX "users_organization_id_unique";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_unique" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_organization_id_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
-- Backfill (idempotent): mevcut her kullanıcı kendi firmasının owner'ıdır.
INSERT INTO "organization_members" ("organization_id", "user_id", "role")
SELECT "organization_id", "id", 'owner' FROM "users" WHERE "organization_id" IS NOT NULL
ON CONFLICT ("organization_id", "user_id") DO NOTHING;
