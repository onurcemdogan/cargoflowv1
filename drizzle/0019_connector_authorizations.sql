CREATE TABLE "connector_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"store_url" text NOT NULL,
	"callback_token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_scope" text NOT NULL,
	"granted_scope" text,
	"encrypted_credentials" text,
	"error_class" text,
	"marketplace_account_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"callback_received_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "connector_authorizations_status_check" CHECK ("connector_authorizations"."status" in ('pending', 'callback_received', 'verifying', 'connected', 'failed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "connector_authorizations" ADD CONSTRAINT "connector_authorizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_authorizations" ADD CONSTRAINT "connector_authorizations_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_authorizations" ADD CONSTRAINT "connector_authorizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_authorizations_org_provider_idx" ON "connector_authorizations" USING btree ("organization_id","provider_key","created_at");