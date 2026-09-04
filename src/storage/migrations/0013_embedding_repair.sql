-- EPIC-054 — create the embedding table on an installation that missed it.
--
-- Migration 0008 is conditional on pgvector, and it ran before anything
-- installed pgvector: it took its "not installed" branch, was recorded as
-- applied, and the table was never created. Migrations are forward-only and
-- gap-free, so 0008 can never run again — every database provisioned that way
-- reports schema 12 of 12 with nothing pending and has no embedding table.
--
-- This repairs those installations, and is a no-op everywhere else. The
-- ordering defect itself is fixed in the storage provider, which now installs
-- the extension before migrating; this exists because a fix to the order cannot
-- reach a database that was already migrated in the wrong one.
--
-- Still conditional, for 0008's reason: pgvector is optional, and an
-- installation that does not want it must not fail here. An installation that
-- adds pgvector later is repaired by the next run, which is the supported path.
--
-- The table definition is 0008's, unchanged. Two descriptions of one table that
-- could disagree would be worse than the defect.

DO $$
BEGIN
	IF to_regtype('vector') IS NULL THEN
		RAISE NOTICE 'pgvector is not installed; the embedding table was not created. Semantic retrieval will report itself unavailable.';
		RETURN;
	END IF;

	IF to_regclass('ferret.embedding') IS NOT NULL THEN
		RETURN;
	END IF;

	CREATE TABLE "ferret"."embedding" (
		"id" uuid PRIMARY KEY NOT NULL,

		-- Not a foreign key: one column covering both entity and evidence.
		"subject_id" uuid NOT NULL,
		"subject_kind" text NOT NULL,

		-- Vectors from two models are not comparable.
		"model_id" text NOT NULL,
		"model_version" text NOT NULL,
		"dimensions" integer NOT NULL,
		"metric" text NOT NULL,

		"vector" vector NOT NULL,

		-- A vector is not reproducible without knowing what went in.
		"source_content_hash" text NOT NULL,

		"created_at" timestamp with time zone DEFAULT now() NOT NULL,
		"last_indexed_at" timestamp with time zone DEFAULT now() NOT NULL
	);

	-- Without this a nightly run multiplies the table by the number of nights.
	CREATE UNIQUE INDEX "embedding_subject_model_idx"
		ON "ferret"."embedding" ("subject_id", "model_id", "model_version");

	-- The sweep a model upgrade runs.
	CREATE INDEX "embedding_model_idx"
		ON "ferret"."embedding" ("model_id", "model_version");
END
$$;
