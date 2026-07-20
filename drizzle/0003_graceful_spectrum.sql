CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"external_variant_id" text NOT NULL,
	"merchant_sku" text,
	"barcode" text,
	"stock_code" text,
	"color" text,
	"size" text,
	"attributes" jsonb,
	"image_urls" jsonb,
	"primary_image_url" text,
	"quantity" integer,
	"sale_price" numeric(14, 2),
	"list_price" numeric(14, 2),
	"approved" boolean,
	"archived" boolean DEFAULT false NOT NULL,
	"raw_payload_encrypted" text,
	"marketplace_last_modified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"marketplace" text NOT NULL,
	"external_product_id" text NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"category_name" text,
	"product_main_id" text,
	"approved" boolean,
	"archived" boolean DEFAULT false NOT NULL,
	"raw_payload_encrypted" text,
	"marketplace_created_at" timestamp with time zone,
	"marketplace_last_modified_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_org_product_variant_unique" ON "product_variants" USING btree ("organization_id","product_id","external_variant_id");--> statement-breakpoint
CREATE INDEX "product_variants_org_barcode_idx" ON "product_variants" USING btree ("organization_id","barcode");--> statement-breakpoint
CREATE INDEX "product_variants_org_merchant_sku_idx" ON "product_variants" USING btree ("organization_id","merchant_sku");--> statement-breakpoint
CREATE INDEX "product_variants_org_stock_code_idx" ON "product_variants" USING btree ("organization_id","stock_code");--> statement-breakpoint
CREATE INDEX "product_variants_org_archived_idx" ON "product_variants" USING btree ("organization_id","archived");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_marketplace_external_unique" ON "products" USING btree ("organization_id","marketplace","external_product_id");--> statement-breakpoint
CREATE INDEX "products_org_title_idx" ON "products" USING btree ("organization_id","title");--> statement-breakpoint
CREATE INDEX "products_org_product_main_id_idx" ON "products" USING btree ("organization_id","product_main_id");--> statement-breakpoint
CREATE INDEX "products_org_archived_idx" ON "products" USING btree ("organization_id","archived");