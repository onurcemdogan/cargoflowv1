-- ARKA PLAN ETİKET İŞ KUYRUĞU.
--
-- NEDEN VERİTABANI KISITI: taşıyıcı etiketi GERİ ALINAMAZ ve FATURALANABİLİR.
-- "Aynı paket iki kez işlenmesin" güvencesi uygulama katmanında YETMEZ: iki
-- worker, süreç yeniden başlatma ya da webhook+stream aynı paketi aynı anda
-- bulabilir. Tekillik `label_jobs_identity_key` ile VERİTABANINDA durur.
--
-- Kimlik PAKETTİR; `order_number` DEĞİLDİR (bir sipariş birden çok gönderi
-- paketine bölünebilir).
CREATE TABLE "label_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"carrier" text NOT NULL,
	"package_id" text NOT NULL,
	"job_type" text DEFAULT 'LABEL_PREPARE' NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error_code" text,
	"last_error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "label_jobs_identity_key" ON "label_jobs" USING btree ("organization_id","marketplace","carrier","package_id","job_type");--> statement-breakpoint
CREATE INDEX "label_jobs_claim_idx" ON "label_jobs" USING btree ("status","available_at");