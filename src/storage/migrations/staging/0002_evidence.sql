CREATE TABLE "ferret"."evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_id" uuid NOT NULL,
	"field" text,
	"statement" jsonb NOT NULL,
	"method" text NOT NULL,
	"producer" text NOT NULL,
	"producer_version" text NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text,
	"source_url" text,
	"locator" jsonb,
	"source_content_hash" text,
	"confidence" double precision,
	"completeness" text NOT NULL,
	"authority" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"superseded_by" uuid,
	"permission_scope" text,
	"integrity_hash" text NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ferret"."evidence_derivation" (
	"evidence_id" uuid NOT NULL,
	"source_evidence_id" uuid NOT NULL,
	CONSTRAINT "evidence_derivation_evidence_id_source_evidence_id_pk" PRIMARY KEY("evidence_id","source_evidence_id")
);
--> statement-breakpoint
ALTER TABLE "ferret"."evidence" ADD CONSTRAINT "evidence_subject_id_entity_id_fk" FOREIGN KEY ("subject_id") REFERENCES "ferret"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ferret"."evidence_derivation" ADD CONSTRAINT "evidence_derivation_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "ferret"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ferret"."evidence_derivation" ADD CONSTRAINT "evidence_derivation_source_evidence_id_evidence_id_fk" FOREIGN KEY ("source_evidence_id") REFERENCES "ferret"."evidence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_subject_idx" ON "ferret"."evidence" USING btree ("subject_id","field");--> statement-breakpoint
CREATE INDEX "evidence_state_idx" ON "ferret"."evidence" USING btree ("state");--> statement-breakpoint
CREATE INDEX "evidence_source_idx" ON "ferret"."evidence" USING btree ("source_system","source_id");--> statement-breakpoint
CREATE INDEX "evidence_producer_idx" ON "ferret"."evidence" USING btree ("producer","producer_version");--> statement-breakpoint
CREATE INDEX "evidence_permission_idx" ON "ferret"."evidence" USING btree ("permission_scope");--> statement-breakpoint
CREATE INDEX "evidence_derivation_source_idx" ON "ferret"."evidence_derivation" USING btree ("source_evidence_id");