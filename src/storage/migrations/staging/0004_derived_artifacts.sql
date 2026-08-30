CREATE TABLE "ferret"."derived_artifact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_id" uuid,
	"producer" text NOT NULL,
	"producer_version" text NOT NULL,
	"schema_version" integer NOT NULL,
	"source_content_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "derived_artifact_scope_idx" ON "ferret"."derived_artifact" USING btree ("kind","scope_id");--> statement-breakpoint
CREATE INDEX "derived_artifact_producer_idx" ON "ferret"."derived_artifact" USING btree ("producer","producer_version");--> statement-breakpoint
CREATE INDEX "derived_artifact_state_idx" ON "ferret"."derived_artifact" USING btree ("state");