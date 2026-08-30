CREATE SCHEMA "ferret";
--> statement-breakpoint
CREATE TABLE "ferret"."entity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"canonical_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text,
	"source_scope" text,
	"lifecycle" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unknown_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_observed_at" timestamp with time zone,
	"first_indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ferret"."entity_external_id" (
	"entity_id" uuid NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_external_id_entity_id_system_external_id_pk" PRIMARY KEY("entity_id","system","external_id")
);
--> statement-breakpoint
ALTER TABLE "ferret"."entity_external_id" ADD CONSTRAINT "entity_external_id_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "ferret"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_canonical_key_idx" ON "ferret"."entity" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "entity_kind_idx" ON "ferret"."entity" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "entity_source_idx" ON "ferret"."entity" USING btree ("source_system","source_id");--> statement-breakpoint
CREATE INDEX "entity_lifecycle_idx" ON "ferret"."entity" USING btree ("lifecycle");--> statement-breakpoint
CREATE INDEX "entity_last_indexed_idx" ON "ferret"."entity" USING btree ("last_indexed_at");--> statement-breakpoint
CREATE INDEX "entity_external_lookup_idx" ON "ferret"."entity_external_id" USING btree ("system","external_id");