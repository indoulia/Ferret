-- EPIC-109 — the session store: context that outlives the process.
--
-- **The gap this closes.** EPIC-039 to EPIC-043 model a session, capture it,
-- checkpoint it, extract what it decided and recover it — and every one of them
-- excluded persistence by name. EPIC-041 said it plainly: "Database tables,
-- retention policy, or encryption implementation; those belong to storage
-- Epics." That storage Epic was never written, so `SessionRecoveryPort` had one
-- implementation and it was a test double. A session that ended still took its
-- context with it, which is the failure EPIC-043 exists to prevent.
--
-- **Four tables, not one.** A session, its transcript, its checkpoints and what
-- it decided have different lifetimes and different value. The transcript is
-- bulk and is evidence; the memory is a few dozen sentences and is the thing a
-- later session actually wants. EPIC-042 already separated them in the domain
-- for that reason, and collapsing them here would undo it.
--
-- **Timestamps are `timestamptz`, and hashes canonicalise.** This is the
-- convention EPIC-094 arrived at the hard way: an instant hashed as the caller
-- spelled it cannot be recomputed from a `timestamptz` column, and 135 commits
-- were reported corrupt when nothing was. `session_checkpoint.content_hash`
-- covers `checkpointed_at`, so the domain canonicalises that instant before
-- hashing it — see `canonicalInstant`. Storing the spelling instead would keep
-- the bytes and lose every temporal query, which is the wrong trade for a table
-- retention will have to sweep.

-- The session itself. `id` is the domain's canonical id, derived from
-- `session_id`; `session_id` is the natural key a client knows and is what the
-- child tables reference.
CREATE TABLE "ferret"."session" (
	"id" uuid PRIMARY KEY,
	"session_id" text NOT NULL UNIQUE,

	"provider" text NOT NULL,
	-- The human or agent operating the session, which EPIC-039 AC-2 requires be
	-- distinguishable from the session itself.
	"actor_id" text NOT NULL,

	-- Scope, when it is known. Text rather than a foreign key to `entity`: a
	-- session can be recorded outside a repository Ferret has indexed, and
	-- EPIC-039 AC-3 requires these be optional and never fabricated.
	"repository_id" text,
	"worktree_id" text,
	"branch" text,

	-- The session this one continues. Deliberately *not* a foreign key:
	-- `recoverSession` walks the chain and already treats an unresolvable parent
	-- as the end of the lineage, so a dangling link is a shorter recovery rather
	-- than a corrupt row. A constraint here would refuse to record a
	-- continuation whose parent was pruned.
	"parent_session_id" text,

	"started_at" timestamptz NOT NULL,
	"last_activity_at" timestamptz NOT NULL,
	-- NULL exactly while the session is active.
	"ended_at" timestamptz,
	"status" text NOT NULL,

	CONSTRAINT "session_status_known" CHECK ("status" IN ('active', 'completed', 'abandoned')),
	-- EPIC-039 AC-5: an end time exists only after a terminal transition. Stated
	-- as an equivalence so neither half can drift from the other.
	CONSTRAINT "session_ended_with_status" CHECK (("ended_at" IS NULL) = ("status" = 'active')),
	-- Activity cannot precede the start. The domain enforces monotonicity across
	-- writes; this catches a single write that was never coherent.
	CONSTRAINT "session_activity_after_start" CHECK ("last_activity_at" >= "started_at")
);

CREATE INDEX "session_actor_idx" ON "ferret"."session" ("actor_id", "started_at" DESC);
-- "What continues this session" — the lineage walk's reverse direction.
CREATE INDEX "session_parent_idx" ON "ferret"."session" ("parent_session_id")
	WHERE "parent_session_id" IS NOT NULL;

-- The raw transcript. Evidence, in EPIC-008's sense: append-only, and consulted
-- when the checkpoint and the extracted memory are not enough.
CREATE TABLE "ferret"."session_capture" (
	"id" uuid PRIMARY KEY,
	"session_id" text NOT NULL REFERENCES "ferret"."session" ("session_id") ON DELETE CASCADE,

	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	-- Over the content alone, so a re-read of the same turn is recognisable.
	"content_hash" text NOT NULL,
	"captured_at" timestamptz NOT NULL,
	"provider" text NOT NULL,
	"metadata" jsonb,

	CONSTRAINT "session_capture_kind_known" CHECK (
		"kind" IN ('system', 'user', 'assistant', 'tool_call', 'tool_result')
	),
	CONSTRAINT "session_capture_sequence_positive" CHECK ("sequence" > 0),
	-- One turn per sequence number. A second turn claiming a taken sequence is a
	-- capture bug, and silently keeping either version would make the transcript
	-- unorderable.
	CONSTRAINT "session_capture_sequence_unique" UNIQUE ("session_id", "sequence")
);

-- Compact resumable state. One row per checkpoint, never overwritten.
CREATE TABLE "ferret"."session_checkpoint" (
	"id" uuid PRIMARY KEY,
	"session_id" text NOT NULL REFERENCES "ferret"."session" ("session_id") ON DELETE CASCADE,

	"provider" text NOT NULL,
	"checkpoint_sequence" integer NOT NULL,
	-- The highest captured turn this checkpoint represents — EPIC-041 AC-3.
	"captured_through_sequence" integer NOT NULL,
	"checkpointed_at" timestamptz NOT NULL,
	"summary" text NOT NULL,
	"continuation_state" jsonb NOT NULL,
	"content_hash" text NOT NULL,

	CONSTRAINT "session_checkpoint_sequence_positive" CHECK ("checkpoint_sequence" > 0),
	CONSTRAINT "session_checkpoint_watermark_nonnegative" CHECK ("captured_through_sequence" >= 0),
	-- EPIC-041 AC-4: a sequence cannot be reused. Monotonic *progression* is the
	-- domain's to enforce because it needs the previous checkpoint to judge;
	-- uniqueness is enforceable here and so is enforced here.
	CONSTRAINT "session_checkpoint_sequence_unique" UNIQUE ("session_id", "checkpoint_sequence")
);

-- What the session decided and learned — EPIC-042. Kept apart from the
-- transcript because this is the part worth handing to a later session.
CREATE TABLE "ferret"."engineering_memory" (
	-- Derived from session + kind + statement, so re-extracting the same
	-- captures produces the same row rather than a duplicate.
	"id" uuid PRIMARY KEY,
	"session_id" text NOT NULL REFERENCES "ferret"."session" ("session_id") ON DELETE CASCADE,

	"kind" text NOT NULL,
	"statement" text NOT NULL,
	"rationale" text,
	"origin" text NOT NULL,
	-- The rule that matched, for an extracted memory.
	"rule" text,
	"confidence" double precision NOT NULL,
	-- The captures this was drawn from: [{captureId, sequence}, …].
	"derived_from" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"recorded_at" timestamptz NOT NULL,
	-- Credentials removed from the statement and rationale — EPIC-082.
	"redacted_secrets" integer NOT NULL DEFAULT 0,
	"truncated" boolean NOT NULL DEFAULT false,

	-- Supersession, retained both ways. A decision reversed later is not
	-- deleted: "why did we change our mind" is worth answering. Not foreign
	-- keys, for the same reason `parent_session_id` is not one — the two halves
	-- can be written in either order, and across sessions.
	"superseded_by" uuid,
	"supersedes" uuid,

	"content_hash" text NOT NULL,

	CONSTRAINT "engineering_memory_kind_known" CHECK (
		"kind" IN ('decision', 'constraint', 'preference', 'gotcha', 'next-step')
	),
	CONSTRAINT "engineering_memory_origin_known" CHECK ("origin" IN ('explicit', 'extracted')),
	CONSTRAINT "engineering_memory_redactions_nonnegative" CHECK ("redacted_secrets" >= 0),
	-- The invariant EPIC-042 exists to hold: an extracted memory with no
	-- evidence is a claim with nothing behind it. The domain refuses to build
	-- one; this refuses to store one that arrived another way.
	CONSTRAINT "engineering_memory_extracted_has_evidence" CHECK (
		"origin" <> 'extracted' OR jsonb_array_length("derived_from") > 0
	),
	CONSTRAINT "engineering_memory_not_self_superseding" CHECK (
		"superseded_by" IS NULL OR "superseded_by" <> "id"
	)
);

-- "What did this session decide" — the recovery port's hottest question, and
-- the one that runs once per generation of a lineage walk.
CREATE INDEX "engineering_memory_session_idx" ON "ferret"."engineering_memory" ("session_id");
-- Recovery drops superseded memories by default, so the common read is the
-- live ones. Partial, so the index is the size of the answer.
CREATE INDEX "engineering_memory_live_idx" ON "ferret"."engineering_memory" ("session_id", "kind")
	WHERE "superseded_by" IS NULL;
