-- EPIC-054 — vectors for semantic retrieval.
--
-- Hand-written: `vector` is a pgvector type Drizzle does not model.
--
-- CONDITIONAL, because pgvector is optional (EPIC-002). Failing here would
-- break `ferret init` for every installation that never wanted semantic
-- search. Absent the extension the table is not created, status reports it, and
-- semantic retrieval reports itself unavailable.
--
-- The dimension is not fixed: models differ (384, 768, 1536, 3072) and Ferret
-- mandates no vendor. Length is checked per row against the model that produced
-- it. Consequently there is no vector index — one must be built per dimension.

DO $$
BEGIN
	IF to_regtype('vector') IS NULL THEN
		RAISE NOTICE 'pgvector is not installed; the embedding table was not created. Semantic retrieval will report itself unavailable.';
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
