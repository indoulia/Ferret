-- EPIC-126 — durable context reaches full-text retrieval.
--
-- A durable context record is an entity of the registered kind `context`, so
-- storage, relationships, scope filtering and the integrity sweep already work
-- unchanged and **no table is added here**. One thing does not work unchanged:
-- its text lives in `attributes->>'statement'`, which `0007`'s generated
-- `search_vector` does not read, so durable context would be the one kind
-- invisible to the surface every other kind is found through.
--
-- `0007`'s own comment names this as the sanctioned amendment: "A kind whose
-- searchable text is somewhere else adds its key here, which is a visible
-- decision rather than a silent gap." This is that key.
--
-- A generated column's expression cannot be altered in place, so the column is
-- dropped and rebuilt with the GIN index on it. Everything else about the
-- expression is byte-identical to `0007`'s, deliberately: this migration adds
-- one line and changes nothing about how any existing kind is indexed.

DROP INDEX IF EXISTS "ferret"."entity_search_idx";

ALTER TABLE "ferret"."entity" DROP COLUMN "search_vector";

ALTER TABLE "ferret"."entity"
	ADD COLUMN "search_vector" tsvector
	GENERATED ALWAYS AS (
		to_tsvector(
			'english',
			coalesce(attributes->>'name', '') || ' ' ||
			coalesce(attributes->>'description', '') || ' ' ||
			coalesce(attributes->>'path', '') || ' ' ||
			translate(coalesce(attributes->>'path', ''), '/-_.', '    ') || ' ' ||
			coalesce(attributes->>'message', '') || ' ' ||
			coalesce(attributes->>'shortName', '') || ' ' ||
			coalesce(attributes->>'ref', '') || ' ' ||
			coalesce(attributes->>'title', '') || ' ' ||
			-- EPIC-126. What a durable context record says.
			coalesce(attributes->>'statement', '') || ' ' ||
			coalesce(source_id, '')
		)
	) STORED;

CREATE INDEX "entity_search_idx" ON "ferret"."entity" USING gin ("search_vector");

-- No index is added for reading durable context by kind and lifecycle.
-- `entity_kind_idx`, `entity_lifecycle_idx` and `entity_scope_idx` already
-- cover every read this Epic makes, and `scale.test.ts` pins how many indexes
-- go unexercised precisely so a speculative one is a review moment rather than
-- a silent cost. Governance §17: specialise where measurement demands it.
