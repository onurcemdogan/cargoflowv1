CREATE TABLE "integration_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"resource" text NOT NULL,
	"last_successful_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_fetched_count" integer,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"settings_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_sync_state" ADD CONSTRAINT "integration_sync_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_sync_state_org_provider_resource_unique" ON "integration_sync_state" USING btree ("organization_id","provider","resource");--> statement-breakpoint
CREATE INDEX "integration_sync_state_org_resource_idx" ON "integration_sync_state" USING btree ("organization_id","resource");