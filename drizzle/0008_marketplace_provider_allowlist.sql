-- Pazaryeri sağlayıcı allowlist'ini genişletir (P4).
--
-- ÖLÇÜLEN ENGEL: `integration_credentials_provider_check` sağlayıcıyı
-- ('trendyol','surat') ile kilitliyordu; Hepsiburada/n11 kimliği YAZILAMIYORDU.
-- Bu, veri katmanındaki TEK sert engeldi (bkz. P4_AUDIT §2.2).
--
-- YALNIZ allowlist genişler. Kolon, tip, tekillik ve şifreleme sözleşmesi
-- DEĞİŞMEZ; mevcut satırlar ETKİLENMEZ.
ALTER TABLE "integration_credentials"
  DROP CONSTRAINT IF EXISTS "integration_credentials_provider_check";
--> statement-breakpoint
ALTER TABLE "integration_credentials"
  ADD CONSTRAINT "integration_credentials_provider_check"
  CHECK ("integration_credentials"."provider" IN ('trendyol', 'surat', 'hepsiburada', 'n11'));
