CREATE TABLE "marketplace_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"display_name" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"last_successful_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "integration_sync_state_org_provider_resource_unique";--> statement-breakpoint
DROP INDEX "orders_org_marketplace_package_unique";--> statement-breakpoint
DROP INDEX "products_org_marketplace_external_unique";--> statement-breakpoint
ALTER TABLE "integration_sync_state" ADD COLUMN "marketplace_account_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "marketplace_account_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "marketplace_account_id" uuid;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_accounts_org_marketplace_provider_unique" ON "marketplace_accounts" USING btree ("organization_id","marketplace","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_accounts_single_active_unique" ON "marketplace_accounts" USING btree ("organization_id","marketplace") WHERE "marketplace_accounts"."is_active";--> statement-breakpoint
CREATE INDEX "marketplace_accounts_org_marketplace_idx" ON "marketplace_accounts" USING btree ("organization_id","marketplace");--> statement-breakpoint
ALTER TABLE "integration_sync_state" ADD CONSTRAINT "integration_sync_state_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_org_account_idx" ON "orders" USING btree ("organization_id","marketplace_account_id");--> statement-breakpoint
CREATE INDEX "products_org_account_idx" ON "products" USING btree ("organization_id","marketplace_account_id");--> statement-breakpoint
ALTER TABLE "integration_sync_state" ADD CONSTRAINT "integration_sync_state_org_provider_resource_account_unique" UNIQUE NULLS NOT DISTINCT("organization_id","provider","resource","marketplace_account_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_org_marketplace_account_package_unique" UNIQUE NULLS NOT DISTINCT("organization_id","marketplace","marketplace_account_id","package_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_marketplace_account_external_unique" UNIQUE NULLS NOT DISTINCT("organization_id","marketplace","marketplace_account_id","external_product_id");