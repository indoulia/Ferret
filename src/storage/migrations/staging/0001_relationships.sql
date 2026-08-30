CREATE TABLE "ferret"."relationship" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_id" uuid NOT NULL,
	"type" text NOT NULL,
	"to_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_id" text,
	"first_indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ferret"."relationship" ADD CONSTRAINT "relationship_from_id_entity_id_fk" FOREIGN KEY ("from_id") REFERENCES "ferret"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ferret"."relationship" ADD CONSTRAINT "relationship_to_id_entity_id_fk" FOREIGN KEY ("to_id") REFERENCES "ferret"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_assertion_idx" ON "ferret"."relationship" USING btree ("from_id","type","to_id","valid_from");--> statement-breakpoint
CREATE INDEX "relationship_from_idx" ON "ferret"."relationship" USING btree ("from_id","type");--> statement-breakpoint
CREATE INDEX "relationship_to_idx" ON "ferret"."relationship" USING btree ("to_id","type");--> statement-breakpoint
CREATE INDEX "relationship_type_idx" ON "ferret"."relationship" USING btree ("type");--> statement-breakpoint
CREATE INDEX "relationship_open_idx" ON "ferret"."relationship" USING btree ("from_id","type") WHERE "ferret"."relationship"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "relationship_valid_from_idx" ON "ferret"."relationship" USING btree ("valid_from");