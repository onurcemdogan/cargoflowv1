CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"external_line_id" text NOT NULL,
	"product_id" text,
	"merchant_sku" text,
	"barcode" text,
	"product_name" text NOT NULL,
	"variant_attributes" jsonb,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2),
	"line_total" numeric(14, 2),
	"discount_total" numeric(14, 2),
	"line_status" text,
	"image_url" text,
	"raw_payload_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"package_id" text NOT NULL,
	"order_number" text NOT NULL,
	"external_order_id" text,
	"marketplace_status" text,
	"operation_status" text,
	"customer_first_name" text,
	"customer_last_name" text,
	"customer_email" text,
	"customer_phone" text,
	"shipping_address_encrypted" text,
	"shipping_city" text,
	"shipping_district" text,
	"cargo_provider_name" text,
	"cargo_tracking_number" text,
	"cargo_sender_number" text,
	"cargo_tracking_link" text,
	"total_amount" numeric(14, 2),
	"currency" text,
	"order_date" timestamp with time zone NOT NULL,
	"marketplace_last_modified_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"raw_payload_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_org_order_line_unique" ON "order_lines" USING btree ("organization_id","order_id","external_line_id");--> statement-breakpoint
CREATE INDEX "order_lines_org_barcode_idx" ON "order_lines" USING btree ("organization_id","barcode");--> statement-breakpoint
CREATE INDEX "order_lines_org_merchant_sku_idx" ON "order_lines" USING btree ("organization_id","merchant_sku");--> statement-breakpoint
CREATE INDEX "order_lines_org_product_id_idx" ON "order_lines" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_org_marketplace_package_unique" ON "orders" USING btree ("organization_id","marketplace","package_id");--> statement-breakpoint
CREATE INDEX "orders_org_order_date_idx" ON "orders" USING btree ("organization_id","order_date");--> statement-breakpoint
CREATE INDEX "orders_org_marketplace_status_idx" ON "orders" USING btree ("organization_id","marketplace_status");--> statement-breakpoint
CREATE INDEX "orders_org_operation_status_idx" ON "orders" USING btree ("organization_id","operation_status");--> statement-breakpoint
CREATE INDEX "orders_org_order_number_idx" ON "orders" USING btree ("organization_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_org_archived_at_idx" ON "orders" USING btree ("organization_id","archived_at");