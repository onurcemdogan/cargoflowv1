-- WOOCOMMERCE-001 — UC SEMA ENGELI (yeniden uretildi, varsayilmadi).
--
-- A) marketplace_accounts_single_active_unique
--    (org, marketplace) icin EN FAZLA bir aktif hesaba izin veriyordu.
--    Bir organizasyon AYNI ANDA birden cok WooCommerce magazasi baglar.
--    Kisit DB'den kalkar; TEK AKTIF HESAP garantisi Trendyol icin
--    `resolveOrCreateActiveAccount` icinde ZATEN uygulama mantigindadir
--    (kardesleri pasiflestiren adim), bu yuzden Trendyol davranisi DEGISMEZ.
--
-- B) integration_credentials UNIQUE(organization_id, provider) idi ve
--    provider allowlist'i 'woocommerce' ICERMIYORDU. Ayni org'un iki magaza
--    sirrini TEMSIL EDEMEZ. Eski tablo Trendyol/Surat icin OLDUGU GIBI KALIR;
--    hesap kapsamli sirlar AYRI ve SAGLAYICI-NOTR tabloya yazilir.
--
-- C) Dayanikli webhook gelen kutusu YOKTU. WooCommerce sozlesmesi ardisik 5
--    basarisiz teslimden sonra webhook'u DISABLED yapar; bu yuzden dogrulama
--    sonrasi KALICI yazim 2xx'ten ONCE gelmek zorundadir.
--
-- Bu dosya `drizzle-kit generate` ile URETILDI (snapshot da uretildi);
-- elle yazilmis surumu snapshot BIRAKMIYORDU ve sonraki generate mukerrer
-- migration uretirdi (MIG-13/MIG-15 bunu yakaladi).

CREATE TABLE "connector_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace_account_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"delivery_id" text NOT NULL,
	"topic" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"error_code" text,
	"encrypted_payload" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "marketplace_accounts_single_active_unique";--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_inbox" ADD CONSTRAINT "connector_webhook_inbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_webhook_inbox" ADD CONSTRAINT "connector_webhook_inbox_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_credentials_account_provider_unique" ON "connector_credentials" USING btree ("organization_id","marketplace_account_id","provider_key");--> statement-breakpoint
CREATE INDEX "connector_credentials_org_provider_idx" ON "connector_credentials" USING btree ("organization_id","provider_key");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_webhook_inbox_delivery_unique" ON "connector_webhook_inbox" USING btree ("organization_id","marketplace_account_id","provider_key","delivery_id");--> statement-breakpoint
CREATE INDEX "connector_webhook_inbox_status_idx" ON "connector_webhook_inbox" USING btree ("organization_id","provider_key","status");--> statement-breakpoint
CREATE INDEX "marketplace_accounts_org_marketplace_active_idx" ON "marketplace_accounts" USING btree ("organization_id","marketplace","is_active");