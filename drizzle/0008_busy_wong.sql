CREATE TABLE "order_filter_projection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"marketplace_token" text,
	"operation_status_token" text,
	"marketplace_status" text,
	"shipping_city_token" text,
	"shipping_district_token" text,
	"customer_search_token" text,
	"order_number_order_token" text,
	"order_number_shipment_token" text,
	"cargo_slip_order_token" text,
	"cargo_slip_shipment_token" text,
	"cargo_slip_operation_token" text,
	"order_date" timestamp with time zone,
	"projection_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_filter_projection" ADD CONSTRAINT "order_filter_projection_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_filter_projection" ADD CONSTRAINT "order_filter_projection_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_filter_projection_org_order_unique" ON "order_filter_projection" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE INDEX "order_filter_projection_org_version_idx" ON "order_filter_projection" USING btree ("organization_id","projection_version");