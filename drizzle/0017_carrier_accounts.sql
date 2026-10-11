CREATE TABLE "carrier_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"external_account_ref" text,
	"credential_ref" text NOT NULL,
	"credential_fingerprint" text,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_verification_attempt_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carrier_accounts_verification_status_check" CHECK ("carrier_accounts"."verification_status" in ('unverified', 'verified', 'auth_failed', 'permission_denied', 'provider_unavailable', 'rate_limited'))
);
--> statement-breakpoint
CREATE TABLE "marketplace_carrier_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"carrier_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "verification_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "last_verification_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD COLUMN "credential_fingerprint" text;--> statement-breakpoint
ALTER TABLE "carrier_accounts" ADD CONSTRAINT "carrier_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_carrier_mappings" ADD CONSTRAINT "marketplace_carrier_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_carrier_mappings" ADD CONSTRAINT "marketplace_carrier_mappings_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_carrier_mappings" ADD CONSTRAINT "marketplace_carrier_mappings_carrier_account_id_carrier_accounts_id_fk" FOREIGN KEY ("carrier_account_id") REFERENCES "public"."carrier_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_accounts_org_provider_credential_unique" ON "carrier_accounts" USING btree ("organization_id","provider","credential_ref");--> statement-breakpoint
CREATE INDEX "carrier_accounts_org_provider_idx" ON "carrier_accounts" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_carrier_mappings_account_unique" ON "marketplace_carrier_mappings" USING btree ("organization_id","marketplace_account_id");--> statement-breakpoint
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_verification_status_check" CHECK ("marketplace_accounts"."verification_status" in ('unverified', 'verified', 'auth_failed', 'permission_denied', 'provider_unavailable', 'rate_limited'));--> statement-breakpoint
-- Backfill (idempotent): kayıtlı Sürat kimliği olan her organizasyon için
-- taşıyıcı hesabı. Sır TAŞINMAZ; credential_ref şifreli kaydı gösterir.
INSERT INTO "carrier_accounts" ("organization_id", "provider", "display_name", "credential_ref")
SELECT "organization_id", 'surat', 'Sürat Kargo', 'integration_credentials:surat'
FROM "integration_credentials" WHERE "provider" = 'surat'
ON CONFLICT ("organization_id", "provider", "credential_ref") DO NOTHING;
--> statement-breakpoint
-- Backfill (idempotent): marketplace_accounts içinde duran Aras hesapları
-- taşıyıcı hesabı olarak tanımlanır; kimlik connector_credentials'ta kalır.
INSERT INTO "carrier_accounts" ("organization_id", "provider", "display_name", "credential_ref", "enabled")
SELECT "organization_id", 'aras', COALESCE("display_name", 'Aras Kargo'), 'connector_credentials:' || "id", "is_active"
FROM "marketplace_accounts" WHERE "marketplace" = 'aras'
ON CONFLICT ("organization_id", "provider", "credential_ref") DO NOTHING;
