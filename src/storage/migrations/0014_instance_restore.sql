-- EPIC-090 D2 — a restored index can say what it is a restore of.
--
-- **The gap this closes.** `ferret import` writes another installation's rows
-- into this one and leaves no record that it happened. `ferret.instance` holds
-- the identity migration 0001 minted for *this* database, which is correct and
-- must stay correct — two installations sharing one identity is worse than a
-- restored index that cannot name its source. So the source identity cannot go
-- there, and before this table it had nowhere to go at all: a restored index
-- was indistinguishable from one that had indexed the same repositories itself.
--
-- **Why a table and not columns on `ferret.instance`.** That row is a singleton
-- describing this installation. A restore is an event, it can happen more than
-- once, and Governance §6 makes source provenance append-only — "must not be
-- silently rewritten". Columns would record only the latest import and would
-- overwrite the previous one, which is the rewrite the rule forbids.
--
-- **Why it is not exported.** This is bookkeeping about *this* database, like
-- `schema_migrations`. Carrying it into another installation would assert that
-- installation was restored from something it was not. `EXPORT_EXCLUSIONS`
-- names it, and a test asserts every table is either exported or named there.

CREATE TABLE "ferret"."instance_restore" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

	-- This installation's own identity at the moment of the restore. Recorded
	-- rather than joined: if `ferret.instance` were ever re-provisioned, the
	-- history of what was restored into which identity is still readable.
	"instance_id" uuid NOT NULL,

	-- The identity of the installation the document came from. This is the whole
	-- point of the table. NULL is possible and meaningful: a document written
	-- before the manifest carried a source identity cannot supply one, and
	-- saying so is better than recording a guess.
	"source_instance_id" uuid,

	-- What wrote the document, and when it was written. Enough to find the
	-- source installation's own records without holding a reference to it.
	"source_ferret_version" text NOT NULL,
	"source_exported_at" timestamptz NOT NULL,

	-- The trailer's digest. Identifies the exact document, so two restores of
	-- the same backup are distinguishable from restores of two backups.
	"document_digest" text NOT NULL,

	"rows_written" integer NOT NULL,
	"restored_at" timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE "ferret"."instance_restore" IS
	'Append-only provenance: which document was imported into this installation, and which installation wrote it. Created by EPIC-090 D2.';

-- "What is the most recent restore" is the question `ferret init` and the
-- schema report ask, and the only one asked often.
CREATE INDEX "instance_restore_restored_at_idx"
	ON "ferret"."instance_restore" ("restored_at" DESC);
