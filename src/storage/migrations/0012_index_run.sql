-- EPIC-094 — the run journal: intent recorded before effect.
--
-- **The gap this closes.** Transactions are per batch, never per run, and the
-- watermark moves only after every stage succeeded — both correct. Together
-- they mean a run killed after stage 2 leaves entities and relationships
-- written and *no record that it ever started*. The health probe then finds
-- zero artefacts and answers "nothing has been indexed yet" to an operator
-- whose database holds thousands of rows. Recovery works by idempotence — run
-- it again — and nothing tells anyone to.
--
-- **Why not `derived_artifact`.** That table holds one current row per
-- `(kind, scope_id)`, which is exactly right for a watermark and exactly wrong
-- for a history of attempts. A run that failed and a run that succeeded after
-- it are two facts, and the first is the one an operator needs.
--
-- **Why an open row is the whole mechanism.** A row written before the first
-- stage and closed after the last. An open row whose process is gone *is* the
-- definition of a partially applied run — there is no other way to distinguish
-- "nothing was indexed" from "indexing died", because the rows a dead run left
-- behind are indistinguishable from the rows a good run left behind.

CREATE TABLE "ferret"."index_run" (
	"id" uuid PRIMARY KEY,

	-- The repository entity this run was for. Not a foreign key: the run is
	-- opened *before* the first stage, so on a first index the repository entity
	-- does not exist yet, and a constraint here would make recording the attempt
	-- depend on the attempt having already partly succeeded.
	"repository_id" uuid,
	-- What the operator named, for a run that never got as far as an entity.
	"repository_key" text NOT NULL,

	"started_at" timestamptz NOT NULL DEFAULT now(),
	-- NULL means open. An open row older than any plausible run is the finding.
	"finished_at" timestamptz,

	-- 'succeeded' or 'failed' once closed; NULL while open. Governance §6 — a
	-- run in progress and a run that ended must not look the same.
	"outcome" text,

	-- Which build, and which process. The pid is not an identity across
	-- restarts and is not treated as one; it is what an operator greps for while
	-- the run is still going.
	"ferret_version" text NOT NULL,
	"host_pid" integer NOT NULL,
	-- EPIC-091's per-invocation correlation id, so a run's rows and its log
	-- lines can be lined up without guessing from timestamps.
	"invocation" text,

	-- What the run did, filled in when it closes. Free-shaped on purpose: the
	-- counts an index run reports are EPIC-031's and change with it, and pinning
	-- them into columns here would make this table a second place they are
	-- defined.
	"summary" jsonb NOT NULL DEFAULT '{}'::jsonb,

	CONSTRAINT "index_run_outcome_known" CHECK (
		"outcome" IS NULL OR "outcome" IN ('succeeded', 'failed')
	),
	-- Open means no outcome; closed means both. Neither half alone is a state a
	-- run can be in, and a check is the only version of that promise a future
	-- caller cannot route around.
	CONSTRAINT "index_run_closed_together" CHECK (
		("finished_at" IS NULL) = ("outcome" IS NULL)
	)
);

-- "Which runs are still open" is the question this table exists to answer, and
-- it is asked by a health probe that must stay fast. Partial, so the index is
-- the size of the answer rather than of the history.
CREATE INDEX "index_run_open_idx"
	ON "ferret"."index_run" ("started_at")
	WHERE "finished_at" IS NULL;

-- "What happened to this repository, most recently first."
CREATE INDEX "index_run_repository_idx" ON "ferret"."index_run" ("repository_key", "started_at" DESC);
