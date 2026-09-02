# EPIC-090 — Data Import & Recovery

**Status: VALIDATED | Priority: P1 | Domain: Storage & Data Lifecycle**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Storage & Data Lifecycle;
> only the specification is new.

## 1. Objective

Read a document [EPIC-089](EPIC-089-Backup-And-Export.md) wrote — into a
different version, a different database, or a fresh one — and refuse it clearly
when it cannot be read.

## 2. Value

EPIC-089 wrote a format and validated it with a reader **whose author was the
writer's**, which its §16 records as the weaker guarantee. This Epic is the
reader written against the format, and that is most of the value: a format is
validated by an independent consumer or it is not validated.

Three records route work here:

- **`COMPATIBILITY.md` §7** — "Import of data exported by another
  installation." A migration runs forward and there is no `down`, so a
  downgrade has no other path.
- **EPIC-094 §4** — "Recovery here means re-deriving from a source Ferret can
  still read; recovery from a source that is **gone** is EPIC-090's."
- **EPIC-082 §4** and **EPIC-081 §4** — "retroactive scrubbing of an index
  already written", deferred here on data-lifecycle grounds. §8.7 answers it,
  and the answer is that this Epic already provides the mechanism.

## 3. Scope

- **`ferret import <document>`** — manifest checked, then rows, then the
  trailer's digest verified.
- **Refusal before any write** on a version, format or integrity mismatch.
- **A plan, then a confirmed write** — EPIC-088's shape, for its reason.
- **Idempotence**: importing the same document twice changes nothing the second
  time.
- **Naming export-then-import as the scrubbing mechanism** — §8.7.

## 4. Non-scope

- **Merging two indexes into one.** §16. An import into a non-empty index is
  supported (§8.4) but "reconcile two installations' disagreements" is a
  different problem with no owner.
- **Rewriting a row in place to remove a secret.** §8.7 — Governance §6, and the
  mechanism is export-then-import.
- **Restoring a `pg_dump`.** That is `pg_restore`, and EPIC-089 §8.1 already
  refused to wrap the pair.
- **Importing a format Ferret did not write.** §8.2 refuses an unknown
  manifest rather than guessing.
- **Re-deriving anything.** An import writes what the document says. Where the
  source is still readable, `ferret index` is the better tool and EPIC-094 owns
  the repair.

## 5. Inputs

An NDJSON document as EPIC-089 §8.2 defines it: manifest, rows, trailer.

## 6. Outputs

`src/storage/import.ts`, `ferret import`, and a report naming what was written,
what was already present, and what was refused.

## 7. Dependencies

EPIC-089 (the format), EPIC-086 (the store), EPIC-080 (idempotent ingestion —
the invariant this leans on), EPIC-088 (the confirmation shape), EPIC-085 (the
audit event), EPIC-010 (schema compatibility).

## 8. Contracts

### 8.1 Nothing is written until the whole document has been read

The digest is in the trailer, so integrity is only knowable at the end. An
import therefore reads the document **twice**: once to check it, once to write
it. That is the cost of the trailer, and it is the right way round — a partial
import is worse than a slow one, because it leaves an index that looks complete.

A document with no trailer is **truncated** and is refused. EPIC-089 §8.2 put
the digest at the end precisely so this case is detectable.

### 8.2 The manifest is checked first, and an unknown one is refused

`format`, `kind` and `entitySchemaVersion` are read before anything else. A
format this build does not know is refused by name rather than parsed
optimistically; a schema version **newer** than this build understands is
refused for the reason EPIC-002 gives for the database and EPIC-006 for the
entity envelope — "reading a newer envelope under the old meaning would apply an
interpretation the writer never intended, and quietly."

An **older** schema version is accepted, because that is the downgrade path
`COMPATIBILITY.md` §7 sends here.

### 8.3 An import is idempotent, and that is inherited rather than added

Every id in the document is content-derived (EPIC-006), so importing the same
row twice writes the same row. EPIC-080 proved every storage write path
idempotent and keeps proving it; this Epic reuses those paths rather than
issuing its own `INSERT`s. Re-importing a document reports every row as
`unchanged`.

### 8.4 An import into a non-empty index adds; it never silently replaces

A row already present with the same content hash is `unchanged`. A row present
with a **different** hash is a disagreement between two installations, and this
Epic does not adjudicate it: the row is reported as `conflicting` and left
alone, because choosing a winner is the merge problem §4 excludes. `--overwrite`
is not offered; the caller who wants the document's version has an empty
database.

### 8.5 Lifecycle and evidence state are imported as recorded

A `deleted` entity imports as `deleted`. A `superseded` observation imports as
`superseded`. Importing a tombstone as `active` would resurrect a file that was
deleted — and issue #118 is on record for how easily a lifecycle write goes
wrong in the other direction.

### 8.6 Rows are written parents first, and a foreign key failure is the
document's fault, not the operator's

EPIC-089 §8.6 writes the tables in dependency order, and this reads them in the
order given. A row whose parent is absent is reported with the parent's id
rather than surfacing a PostgreSQL constraint name — an export scoped to one
repository can legitimately reference an entity outside it, and telling the
operator *which* is the difference between a diagnosis and a stack trace.

### 8.7 Scrubbing a secret is export-then-import, and never an in-place rewrite

EPIC-082 §4 and EPIC-081 §4 both defer "retroactive scrubbing of an index
already written" here. The answer is that no new mechanism is needed, and that
building one would be worse:

- Governance §6 forbids silently rewriting stored evidence. An `UPDATE` that
  edits a body to remove a credential is exactly that — and leaves no record
  that anything was removed.
- **`ferret export | <filter> | ferret import`** into a fresh database is
  auditable at every step: the document before, the document after, and the
  filter that ran. EPIC-088 §16 reached the same shape for tombstones
  ("export-then-truncate"), and this is that pattern's second caller.

So this Epic *names* the mechanism, documents it, and does not ship a filter:
"which strings are secret in an index already written" is EPIC-082's question,
and its answer is a scanner rather than a rewriter.

### 8.8 An import is an audit event

One event naming the document, the counts and the outcome — the write that most
changes what Ferret believes, and the only one whose source is a file rather
than an observation.

## 9. Acceptance criteria

- **AC-1** A document EPIC-089 wrote imports into an empty database, and every
  table's count matches the trailer.
- **AC-2** A round trip is lossless: export, import into an empty database,
  export again, and the second document's digest equals the first's.
- **AC-3** A document with no trailer is refused, and nothing is written.
- **AC-4** A document whose digest does not match its rows is refused, and
  nothing is written.
- **AC-5** A manifest with an unknown `format` is refused by name.
- **AC-6** A manifest whose `entitySchemaVersion` is newer than this build is
  refused; an older one is accepted.
- **AC-7** Importing the same document twice reports every row `unchanged` the
  second time.
- **AC-8** A row already present with a different content hash is reported
  `conflicting` and left unchanged.
- **AC-9** A `deleted` entity imports as `deleted`.
- **AC-10** A `superseded` observation imports as `superseded`.
- **AC-11** A row whose parent is absent is reported with the parent's id, and
  the rest of the import still completes.
- **AC-12** `import` without `--yes` reports the plan and writes nothing.
- **AC-13** An import refuses without the `INDEX` permission.
- **AC-14** One audit event names the document and the counts.
- **AC-15** An empty document (manifest, trailer, no rows) imports as a no-op.
- **AC-16** After importing a scoped export, every imported `file_version`
  resolves its content — the invariant that makes a partial document usable.

## 10. Test requirements

**Unit** — manifest refusal by format and version; digest verification; the
plan.

**Integration (real PostgreSQL)** — AC-1 to AC-11 and AC-16 against a live
schema, including the **round trip through two databases** which is what
actually validates EPIC-089's format.

**Security** — AC-13, AC-14.

**Failure** — a truncated document; a corrupted line; a document whose parent
rows were excluded by a scope.

**Regression** — EPIC-089's suite unchanged; EPIC-080's idempotence invariant
extended to cover the import path.

## 11. Security requirements

An import is a write, checked as one (AC-13). The document is untrusted input:
every row goes through the same `createEntity` / `createRelationship`
validation an observation does, so a hand-edited document cannot inject a row
the schema forbids. `permission_scope` is imported as recorded and never
widened.

## 12. Observability

The plan and the report: rows written, unchanged, conflicting and refused, per
table. Both modes print the same shape.

## 13. Performance constraints

Streamed, two passes. One transaction per table so a failure isolates, matching
EPIC-088 §8.5's grain.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 with evidence in
`validation/EPIC-090-VALIDATION.md`; `npm run verify` green; the registry
updated; `COMPATIBILITY.md` §7, EPIC-094 §4, EPIC-082 §4 and EPIC-081 §4 struck
with dated notes; EPIC-089 §16's "not yet validated by an independent reader"
limitation closed.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.7 refuses to rewrite a row in place;
  §8.4 refuses to adjudicate a disagreement it has no evidence about.
- **§10 Time and History** — §8.5: a tombstone imports as a tombstone.
- **§12 Security** — AC-13, and the document as untrusted input.
- **§5 Reuse Before Reinvent** — §8.3 leans on EPIC-080's proven write paths
  rather than issuing raw inserts, and §8.7 ships no filter.

## 16. Raised, not absorbed

- **Merging two indexes is not solved.** §8.4 reports a conflict and stops. Two
  installations that observed the same repository at different times will
  disagree about `last_indexed_at` and possibly about content, and picking a
  winner needs a policy nobody has written.
- **No filter is shipped for §8.7.** The mechanism is named and the filter is
  the caller's. "Which strings are secret in an index already written" is
  EPIC-082's question and its answer is a scanner.
- **Two passes over the document.** The cost of EPIC-089's trailer, and the
  right trade against a partial import — but it means importing from a pipe is
  not supported, only from a file.
- **An import does not verify against source.** It writes what the document
  says. A document exported from a compromised installation imports faithfully;
  `ferret verify` is the tool that would notice, afterwards.
- **The round trip proves the format, not the semantics.** AC-2 proves the bytes
  survive. That a re-imported index *answers the same questions* is a stronger
  claim, and EPIC-098's harness is where it would be measured.

## 17. Recorded during implementation

**Two defects in EPIC-089's format, found by this reader.** That is what an
independent consumer is for, and both would have made a document unimportable:

1. **`search_vector` is a `GENERATED ALWAYS` column**, and `SELECT *` put it in
   the document. Inserting one is `428C9`, so *no* document EPIC-089 wrote could
   be imported at all. Generated columns are now excluded on both sides, read
   from `information_schema` rather than listed, so a generated column added by
   a later migration is handled without anyone remembering.
2. **A `jsonb` column holding a scalar needs JSON quoting.** `attributes` holds
   an object, which `JSON.stringify` handled by accident; `evidence.statement`
   can hold a bare string, and `typescript` is not valid JSON while
   `"typescript"` is. PostgreSQL says `22P02`.

Full evidence in [validation](validation/EPIC-090-VALIDATION.md).
