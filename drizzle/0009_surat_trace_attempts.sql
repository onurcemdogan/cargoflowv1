-- SÜRAT DEBUG İZ GEÇMİŞİ (Trace V2) — YALNIZ DEBUG.
--
-- ÖLÇÜLEN KUSUR: Trace V2 hiçbir yere KALICILAŞTIRILMIYORDU. Sunucu izi
-- üretip yanıtta döndürüyor, istemci onu HİÇ okumuyor ve depo yazıcısı
-- (`appendTrace`) HİÇ çağrılmıyordu. Sonuç: gerçek bir create denemesinden
-- sonra bile Canlı Debug "Henüz bir Sürat gönderi denemesi kaydedilmedi."
-- diyordu.
--
-- Bu tablo YALNIZ debug içindir ve silinebilir. `shipment_operations`
-- OPERASYONEL kayıttır ve debug geçmişi olarak KULLANILMAZ.
CREATE TABLE IF NOT EXISTS "surat_trace_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "trace_id" text NOT NULL,
  "schema_version" integer DEFAULT 2 NOT NULL,
  "order_number" text,
  "package_id" text,
  "marketplace" text,
  "service_mode" text,
  "operation" text,
  "final_state" text,
  "stages" jsonb NOT NULL,
  "summary" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "surat_trace_attempts"
  ADD CONSTRAINT "surat_trace_attempts_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "surat_trace_attempts_org_trace_unique"
  ON "surat_trace_attempts" ("organization_id","trace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "surat_trace_attempts_org_created_idx"
  ON "surat_trace_attempts" ("organization_id","created_at");
