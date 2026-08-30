CREATE TABLE "ferret"."identity_alias" (
	"id" uuid PRIMARY KEY NOT NULL,
	"system" text NOT NULL,
	"external_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_class" text NOT NULL,
	"evidence_id" uuid,
	"confidence" double precision,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"first_indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ferret"."identity_alias" ADD CONSTRAINT "identity_alias_actor_id_entity_id_fk" FOREIGN KEY ("actor_id") REFERENCES "ferret"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ferret"."identity_alias" ADD CONSTRAINT "identity_alias_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "ferret"."evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_alias_current_idx" ON "ferret"."identity_alias" USING btree ("system","external_id") WHERE "ferret"."identity_alias"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "identity_alias_lookup_idx" ON "ferret"."identity_alias" USING btree ("system","external_id");--> statement-breakpoint
CREATE INDEX "identity_alias_actor_idx" ON "ferret"."identity_alias" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "identity_alias_class_idx" ON "ferret"."identity_alias" USING btree ("actor_class");