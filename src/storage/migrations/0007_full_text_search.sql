-- EPIC-053 — full-text retrieval over canonical entities and evidence.
--
-- Hand-written rather than generated: Drizzle has no representation for a
-- generated `tsvector` column, and the expression is the substantive part.
--
-- **Why a stored generated column and not an expression index.** Ranking needs
-- the vector itself — `ts_rank` takes a `tsvector`, so an expression index would
-- have to recompute it for every row it ranks. Storing it costs disk and buys a
-- rank that is O(matched rows) rather than O(table).
--
-- **Why a curated field list and not every attribute.** A generated column's
-- expression must be IMMUTABLE, which rules out `jsonb_each_text` — it is a
-- set-returning function. The alternative to naming fields would be a trigger,
-- which is a second place for the definition to live and drift from.
--
-- The fields named below are the ones a person actually searches by: what a
-- thing is called, where it lives, and what someone said about it. A kind whose
-- searchable text is somewhere else adds its key here, which is a visible
-- decision rather than a silent gap.
--
-- **Why `english` and not `simple`.** Stemming is the difference between
-- searching for "indexing" and finding "index". It is wrong for identifiers —
-- `getUserById` does not stem usefully — and EPIC-055 is where a hybrid planner
-- decides when to use exact matching instead. A single language is also a
-- limitation, recorded rather than hidden: EPIC-030 owns multilingual content.

ALTER TABLE "ferret"."entity"
	ADD COLUMN "search_vector" tsvector
	GENERATED ALWAYS AS (
		to_tsvector(
			'english',
			coalesce(attributes->>'name', '') || ' ' ||
			coalesce(attributes->>'description', '') || ' ' ||
			coalesce(attributes->>'path', '') || ' ' ||
			-- The same path with its separators replaced by spaces.
			--
			-- PostgreSQL lexes `src/retry-policy.ts` as one token of type
			-- `file`, so `retry-policy` — which parses as three — matches
			-- nothing at all. Correct for a URL, useless for the way people
			-- search for code. Indexing both forms makes `retry policy`,
			-- `retry-policy` and the full path all find it.
			translate(coalesce(attributes->>'path', ''), '/-_.', '    ') || ' ' ||
			coalesce(attributes->>'message', '') || ' ' ||
			coalesce(attributes->>'shortName', '') || ' ' ||
			coalesce(attributes->>'ref', '') || ' ' ||
			coalesce(attributes->>'title', '') || ' ' ||
			coalesce(source_id, '')
		)
	) STORED;

CREATE INDEX "entity_search_idx" ON "ferret"."entity" USING gin ("search_vector");

-- Evidence carries the statements themselves — what a source actually said —
-- which is frequently the only place a phrase appears at all. A commit message
-- is on the commit; a sentence extracted from a document is only ever here.
--
-- `statement` is jsonb of arbitrary shape, so it is cast to text wholesale. That
-- indexes the JSON punctuation too, which costs a little index size and finds
-- nothing a user would search for — acceptable against the alternative of
-- guessing which shape a statement has.
ALTER TABLE "ferret"."evidence"
	ADD COLUMN "search_vector" tsvector
	GENERATED ALWAYS AS (
		to_tsvector('english', coalesce(statement #>> '{}', ''))
	) STORED;

CREATE INDEX "evidence_search_idx" ON "ferret"."evidence" USING gin ("search_vector");

-- Exact structured retrieval (EPIC-052) filters by kind and by source before it
-- does anything else, and both are unindexed today. A composite index rather
-- than two: "every repository" is rare, "every file in this repository" is the
-- question people actually ask.
CREATE INDEX "entity_kind_source_idx" ON "ferret"."entity" ("kind", "source_system");
