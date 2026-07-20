CREATE TABLE "shipment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"package_id" text NOT NULL,
	"order_number" text,
	"provider" text NOT NULL,
	"operation_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"request_fingerprint" text,
	"response_payload_encrypted" text,
	"tracking_number" text,
	"sender_number" text,
	"create_call_count" integer DEFAULT 0 NOT NULL,
	"carrier_create_called" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "shipment_operations_status_check" CHECK ("shipment_operations"."status" in ('pending', 'succeeded', 'failed', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"package_id" text NOT NULL,
	"order_number" text,
	"provider" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"tracking_number" text,
	"sender_number" text,
	"barcode" text,
	"tracking_link" text,
	"carrier_payload_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_source_check" CHECK ("shipments"."source" in ('local_create', 'marketplace_external', 'imported_legacy'))
);
--> statement-breakpoint
ALTER TABLE "shipment_operations" ADD CONSTRAINT "shipment_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_operations_org_idempotency_unique" ON "shipment_operations" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "shipment_operations_org_package_idx" ON "shipment_operations" USING btree ("organization_id","package_id");--> statement-breakpoint
CREATE INDEX "shipment_operations_org_status_idx" ON "shipment_operations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "shipment_operations_created_at_idx" ON "shipment_operations" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_org_marketplace_package_provider_unique" ON "shipments" USING btree ("organization_id","marketplace","package_id","provider");--> statement-breakpoint
CREATE INDEX "shipments_org_package_idx" ON "shipments" USING btree ("organization_id","package_id");