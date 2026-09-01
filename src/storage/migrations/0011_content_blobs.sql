-- EPIC-087 — deduplicated content storage.
--
-- **Why a new table, when EPIC-034 and EPIC-108 both declined one.** Those two
-- stored things that *are* entities — a symbol has an identity, a lifecycle and
-- provenance, so it belongs in `entity`. Content has none of that. The same
-- bytes appear at many paths, in many revisions, in many repositories, and
-- outlive every one of them. Keyed by anything but its hash it is not one thing;
-- keyed by its hash it is not an entity. Governance §5 wants the decision
-- visible rather than defaulted, and this is it.
--
-- Reached only *through* the `file_version` entities that carry the same hash in
-- `attributes->>'contentHash'`. No path column, no repository column: a second
-- answer to "where does this content live" is a second thing to keep in step,
-- and it would carry a path across the permission boundary that the join to
-- `entity` exists to hold.

CREATE TABLE "ferret"."content_blob" (
	-- EPIC-022/023's content hash, as `file_version.attributes->>'contentHash'`
	-- already spells it. Not re-derived anywhere; it arrives with the bytes.
	"content_hash" text PRIMARY KEY,

	"byte_size" integer NOT NULL,
	"media_type" text,
	"encoding" text,

	-- The body, after EPIC-082 redaction. NULL is never bare: `omitted_reason`
	-- says which empty this is.
	"text_content" text,
	"omitted_reason" text,

	"first_seen_at" timestamptz NOT NULL DEFAULT now(),

	-- Governance §6 — "no result" and "nothing there" must not look the same.
	-- Text and a reason are mutually exclusive, and one of them is required, so
	-- a row can never be silently empty.
	CONSTRAINT "content_blob_text_xor_reason" CHECK (
		("text_content" IS NULL) <> ("omitted_reason" IS NULL)
	),

	CONSTRAINT "content_blob_reason_known" CHECK (
		"omitted_reason" IS NULL OR "omitted_reason" IN (
			'binary', 'over-size-bound', 'undecodable', 'secret-scan-failed'
		)
	),

	CONSTRAINT "content_blob_size_non_negative" CHECK ("byte_size" >= 0)
);

-- The body, indexed twice.
--
-- `to_tsvector('english', 'authenticateUser')` is one lexeme, `authenticateus`.
-- The query `authenticate` stems to `authent` and matches none of it — so a
-- content table without this would store every body and still leave EPIC-098's
-- `text-authentication` query at 0.00, which is the measurement this Epic exists
-- to move.
--
-- So the verbatim text is indexed for prose, and a camel/Pascal-split copy is
-- indexed for identifiers. Snake case needs no rule: PostgreSQL's parser already
-- splits on `_`, which is also why migration 0007 only had to `translate` paths.
--
-- Stored and generated, for 0007's reasons: `ts_rank` takes a `tsvector`, and an
-- expression index would recompute it for every row it ranks. Both
-- `regexp_replace/4` and a literal-config `to_tsvector` are IMMUTABLE, which is
-- what a generated column requires — the migration failing to apply is the proof.
--
-- Splitting at *write* time instead was rejected: it would store a mangled body,
-- and `ts_headline` would then quote text that does not appear in the file.
ALTER TABLE "ferret"."content_blob"
	ADD COLUMN "search_vector" tsvector
	GENERATED ALWAYS AS (
		to_tsvector(
			'english',
			coalesce("text_content", '') || ' ' ||
			regexp_replace(coalesce("text_content", ''), '([a-z0-9])([A-Z])', '\1 \2', 'g')
		)
	) STORED;

CREATE INDEX "content_blob_search_idx" ON "ferret"."content_blob" USING gin ("search_vector");

-- The join that turns a content hit into an answer: hash → every `file_version`
-- that carries it. Partial, for migration 0010's reason — `contentHash` is an
-- attribute only `file_version` has, and an unpartitioned index would carry an
-- entry for every entity in the graph to answer a question asked about one kind.
CREATE INDEX "entity_file_version_content_hash_idx"
	ON "ferret"."entity" ((attributes->>'contentHash'))
	WHERE kind = 'file_version';
