CREATE TABLE "aras_label_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_code" text NOT NULL,
	"artifact_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aras_label_artifacts" ADD CONSTRAINT "aras_label_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aras_label_artifacts_org_integration_code_unique" ON "aras_label_artifacts" USING btree ("organization_id","integration_code");