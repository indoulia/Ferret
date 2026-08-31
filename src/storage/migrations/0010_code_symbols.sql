-- EPIC-034 — making the symbols a file declares findable.
--
-- No new table. A symbol *is* a canonical entity: EPIC-033 registers
-- `code_symbol`, and EPIC-006 already answers identity, lifecycle, provenance
-- and tombstones for every entity. A dedicated table would be a second place
-- for all of that to live and drift from. Governance §5 is explicit, and the
-- cost of that decision is paid here, in indexes.
--
-- Every index below is **partial** on `kind = 'code_symbol'`. A repository's
-- symbols outnumber its files by an order of magnitude, so an unpartitioned
-- index on `attributes->>'name'` would carry an entry for every entity that has
-- a name — repositories, branches, commits, developers — to answer a question
-- only ever asked about symbols. The partial index is a fraction of the size
-- and is the one the planner picks.
--
-- The scope index in 0009 already covers `(source_scope, kind)`, which is what
-- "every symbol in this file" and reconciliation both use. Nothing here
-- duplicates it.

-- "Where is `resolveConfig` defined" — the most common question asked of a code
-- assistant, and the one a full-text search answers worst, because it ranks
-- every call site above the definition.
CREATE INDEX "entity_code_symbol_name_idx"
	ON "ferret"."entity" ((attributes->>'name'))
	WHERE kind = 'code_symbol';

-- `Box.width`, which is the only name unique within a file.
CREATE INDEX "entity_code_symbol_qualified_name_idx"
	ON "ferret"."entity" ((attributes->>'qualifiedName'))
	WHERE kind = 'code_symbol';

-- "Every symbol in this file", when the caller has a path and not a scope.
-- Also the sort key, so an ordered page does not need a separate sort.
CREATE INDEX "entity_code_symbol_path_idx"
	ON "ferret"."entity" ((attributes->>'path'), (attributes->>'startLine'))
	WHERE kind = 'code_symbol';

-- Prefix search: "what is called something like `resolve`".
--
-- `text_pattern_ops` rather than the default operator class, because `LIKE
-- 'resolve%'` can only use an index built for pattern matching — the default
-- collation-aware ordering does not support it, and without this the prefix
-- query is a sequential scan that looks fine on a test fixture and is
-- unusable on a real repository.
CREATE INDEX "entity_code_symbol_name_prefix_idx"
	ON "ferret"."entity" ((attributes->>'name') text_pattern_ops)
	WHERE kind = 'code_symbol';
