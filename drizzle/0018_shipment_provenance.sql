ALTER TABLE "shipment_operations" ADD COLUMN "marketplace_account_id" uuid;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "carrier_account_id" uuid;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "payer_type" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "payer_source" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "expected_payer" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "resolved_payer" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "contract_source" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "rate_source" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "carrier_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "preflight_reference" text;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD COLUMN "preflight_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "marketplace_account_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_account_id" uuid;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "payer_type" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "payer_source" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "expected_payer" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "resolved_payer" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "contract_source" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "rate_source" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "carrier_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "preflight_reference" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "preflight_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD CONSTRAINT "shipment_operations_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD CONSTRAINT "shipment_operations_carrier_account_id_carrier_accounts_id_fk" FOREIGN KEY ("carrier_account_id") REFERENCES "public"."carrier_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_marketplace_account_id_marketplace_accounts_id_fk" FOREIGN KEY ("marketplace_account_id") REFERENCES "public"."marketplace_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrier_account_id_carrier_accounts_id_fk" FOREIGN KEY ("carrier_account_id") REFERENCES "public"."carrier_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD CONSTRAINT "shipment_operations_payer_type_check" CHECK ("shipment_operations"."payer_type" is null or "shipment_operations"."payer_type" in ('MARKETPLACE_PAYS', 'SELLER_PAYS'));--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD CONSTRAINT "shipment_operations_payer_source_check" CHECK ("shipment_operations"."payer_source" is null or "shipment_operations"."payer_source" in ('ORDER_CONTRACT', 'ACCOUNT_CONFIG', 'TENANT_CONFIG'));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_payer_type_check" CHECK ("shipments"."payer_type" is null or "shipments"."payer_type" in ('MARKETPLACE_PAYS', 'SELLER_PAYS'));--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_payer_source_check" CHECK ("shipments"."payer_source" is null or "shipments"."payer_source" in ('ORDER_CONTRACT', 'ACCOUNT_CONFIG', 'TENANT_CONFIG'));--> statement-breakpoint
-- Kanıta dayalı doğrulama backfill'i (idempotent): bu organizasyonun Sürat
-- kimliğiyle taşıyıcının KABUL ETTİĞİ bir gönderi varsa ve bu başarı kimliğin
-- son değişiminden SONRA gerçekleştiyse, taşıyıcı hesabı doğrulanmış sayılır.
-- Kimlik başarıdan sonra değiştiyse hesap doğrulanmamış KALIR.
UPDATE "carrier_accounts" AS ca
SET "verification_status" = 'verified',
    "last_verified_at" = evidence."verified_at",
    "last_verification_attempt_at" = evidence."verified_at",
    "updated_at" = now()
FROM (
  SELECT so."organization_id", max(COALESCE(so."completed_at", so."updated_at")) AS "verified_at"
  FROM "shipment_operations" so
  WHERE so."provider" = 'surat' AND so."status" = 'succeeded'
  GROUP BY so."organization_id"
) AS evidence,
"integration_credentials" ic
WHERE ca."organization_id" = evidence."organization_id"
  AND ic."organization_id" = ca."organization_id"
  AND ic."provider" = 'surat'
  AND ca."provider" = 'surat'
  AND ca."credential_ref" = 'integration_credentials:surat'
  AND ca."verification_status" = 'unverified'
  AND ca."credential_fingerprint" IS NULL
  AND evidence."verified_at" >= ic."updated_at";
