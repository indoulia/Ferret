# EPIC-094 — Index Integrity & Recovery

**Status: APPROVED | Priority: P0 | Domain: Reliability & Operations**

> **Specification note.** Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry (`README.md:205`), Governance §6, §10, §13, §18, §20 and §21,
> and the six records that parked work here: `EPIC-032` §4, `EPIC-004`
> validation §"degraded index", `EPIC-010` validation,
> `Checkpoints/EPIC-004.md:110`, `Checkpoints/EPIC-010.md:112` and
> `Architecture/COMPATIBILITY.md:162`. It introduces no capability the registry
> did not approve. Measurements are at `594d858`.

## 1. Objective

Let Ferret find out that what it stored is wrong or stale, say so in a sentence
an operator can act on, and fix it by re-deriving from source — without anyone
opening `psql`.

## 2. Value — the problem, measured

Governance §13: *"Corrupt or stale derived indexes must be detectable and
recoverable without requiring the user to become a database administrator."*
Neither half holds today. Measured at `594d858`:

**Evidence is the only thing that can be checked at all.** `integrityHashOf`
(`src/domain/evidence.ts:378`) covers the immutable half of a record;
`EvidenceStore.verify` (`src/storage/evidence.ts:454`) recomputes it and raises
`E_EVIDENCE_TAMPERED` (`src/errors/codes.ts:61`). That is EPIC-008 AC-6, PASS in
`validation/EPIC-008-VALIDATION.md:24`.

It is also unreachable. `verify` and `verifyAll` have **no production caller** —
every reference in the tree is a test
(`tests/integration/domain/evidence-store.test.ts`,
`tests/integration/retrieval/permission.test.ts`). No command, no health probe
and no MCP tool invokes either. And `verifyAll` (`src/storage/evidence.ts:497`)
takes a single `subjectId` and reads at most `limit: 1_000` rows
(`src/storage/evidence.ts:499`), then returns `checked` as if it were the whole
subject. There is no installation-wide sweep.

**Entities and relationships have no integrity check of any kind.** Both tables
carry `content_hash` (`src/storage/schema/entities.ts:81`,
`src/storage/schema/relationships.ts:50`), computed over everything a change
could alter (`src/domain/entity.ts:260`, `src/domain/relationship.ts:361`). It is
used for exactly one thing: comparing two *in-memory* canonical values during
ingestion to skip an unchanged write (`src/storage/entities.ts:153`,
`src/storage/relationships.ts:166`). **Nothing recomputes it from a stored row.**
An entity whose `attributes` were edited outside Ferret verifies against nothing
and is served as fact. The ingredients for the check already exist — the hash is
stored, the function is pure, and `canonicalKey`/`canonicalId`
(`src/domain/identity.ts:54,73`) make the identity recomputable too — but no
caller asks.

Referential integrity is not the gap: `evidence.subject_id` and both relationship
endpoints are foreign keys to `entity.id` (`src/storage/schema/evidence.ts:33`,
`src/storage/schema/relationships.ts:29`). Dangling rows are impossible. Silent
divergence is not.

**Watermarks detect one staleness case and repair it by accident.**
`#readWatermark` (`src/indexing/indexer.ts:705`) discards a watermark whose
`producerVersion` differs from `VERSION`, falling back to a full read. That is
detection plus recovery, and it is the only instance of the pattern on the
canonical path. The general machinery beside it is dead:
`CompatibilityService.staleArtifacts` (`src/storage/compatibility.ts:246`) and
`markStale` (`src/storage/compatibility.ts:295`) have **no production caller** —
confirming `validation/EPIC-010-VALIDATION.md:106`, *"Nothing rebuilds a stale
derived artefact. The marking exists, the rebuild does not."* EPIC-108's content
stage is the one subsystem that closes the loop, gating on `validateArtifact` and
re-deriving on mismatch (`src/indexing/content.ts:393-410`).

**The `index-integrity` probe reports version skew and nothing else.**
`src/storage/provider.ts:290-350` runs one aggregate over
`ferret.derived_artifact` and compares `producer_version` to `VERSION`. It reads
no entity, no relationship and no evidence row. It filters `kind = 'index'`
(`src/storage/provider.ts:299`), so a `content-index` artefact
(`src/indexing/content.ts:42`) built by a superseded parser is invisible to it.
EPIC-032 raised the component from a hard-coded constant to real state
(`validation/EPIC-032-VALIDATION.md:95-104`) and stopped there, on purpose:
*"`index-integrity` reports; EPIC-094 repairs"*
(`EPIC-032-Index-Lifecycle-And-Tombstones.md:85`).

**Nothing can detect a partially applied run.** There is no run journal — no
`index_run`, no `run_id`, anywhere in `src/`. Transactions are per batch
(`src/storage/entities.ts:147`, `src/storage/relationships.ts:141`), never per
run. The watermark moves only after every stage succeeded
(`src/indexing/indexer.ts:560-563`), which is right, and which means a run killed
after stage 2 leaves entities and relationships written and **no record that it
ever started**. Worse, on a first run the health probe then finds zero artefacts
and answers `unknown` — *"Nothing has been indexed yet, so index integrity cannot
be assessed"* (`src/storage/provider.ts:308-317`) — to an operator whose database
holds thousands of rows. Recovery works, by idempotence: run it again. Nothing
tells anyone to.

**The CLI offers no repair.** `ferret status` and `ferret doctor`
(`src/cli/commands/status.ts:52`, `src/cli/commands/doctor.ts:43`) render the same
`HealthReport`; `index-integrity` arrives as one non-required component among
many, and the remediation for skew is prose telling the operator that the next
`ferret index` will sort it out (`src/storage/provider.ts:328-331`). No command
verifies. No command repairs. The fourteen MCP tools include neither health nor
integrity. The DBA §13 forbids is exactly who the current answer requires.

## 3. Scope

1. **Integrity verification for entities and relationships** — recompute
   `content_hash` and the canonical identity from the stored row, the same check
   EPIC-008 gave evidence.
2. **An installation-wide, bounded, resumable sweep** across entities,
   relationships and evidence, replacing `verifyAll`'s single-subject,
   silently-capped read.
3. **A run journal**, so a run that started and did not finish is a fact on
   record rather than an inference from missing rows.
4. **Staleness marking with a caller** — `markStale` and `staleArtifacts` wired
   to producer and schema version changes, across every artefact kind.
5. **Recovery by re-derivation**: a scope found stale, incomplete or unfinished
   is re-read from source, never patched in place.
6. **A CLI affordance** for both halves — verify without repairing, repair one
   named scope — and findings surfaced through `status`, `doctor` and the
   existing `index-integrity` component.

## 4. Non-scope

- **Backup, snapshot and export** — **EPIC-089**, named as the real recovery path
  for a downgrade in `Architecture/COMPATIBILITY.md:157`.
- **Restoring or importing data produced elsewhere** — **EPIC-090**. Recovery
  here means re-deriving from a source Ferret can still read; recovery from a
  source that is gone is EPIC-090's.
- **Scheduling.** Nothing here runs on a timer. Cadence, drift between scheduled
  passes and unattended operation are **EPIC-078**, with cursors in
  **EPIC-075/076**.
- **Deleting or editing rows to make them verify.** Governance §6 forbids
  rewriting an observation, and `src/storage/evidence.ts:485` already prints the
  only correct remedy: *"Re-index the source to produce a fresh observation; do
  not edit evidence in place."* Repair supersedes; it never mutates.
- **Schema migration, downgrade and forward-only rollback** — **EPIC-002** and
  **EPIC-010**. `assertSafeToWrite` (`src/storage/compatibility.ts:127`) already
  refuses writes against an incompatible schema; this Epic consumes that verdict
  rather than restating it.
- **Retention, purging and exclusion policy** — **EPIC-088**.
- **Embedding rebuild specifics** — **EPIC-054**, the third owner named beside
  this Epic in `COMPATIBILITY.md:162`.
- **Lifecycle and tombstone decisions** — **EPIC-032**, VALIDATED. Its
  reference-lifecycle gap (`validation/EPIC-032-VALIDATION.md`, AC-7 NOT
  APPLICABLE) stays with **EPIC-037/038**; an integrity sweep must not become the
  place where deletion is inferred from absence.
- **The wider diagnostics surface** — **EPIC-095**; **metrics and history** —
  **EPIC-092**; **audit events for a repair** — **EPIC-085**; **provider failure
  isolation** — **EPIC-093**.
- **Repairing a corrupt source.** If Git cannot be read, that is a provider
  failure: reported, not repaired.

## 5. Inputs

- `content_hash` and canonical identity on stored entity and relationship rows
  (EPIC-006, EPIC-007, EPIC-009).
- `integrityHashOf` and `EvidenceStore.verify`/`verifyAll` (EPIC-008).
- `derived_artifact`, `validateArtifact`, `staleArtifacts`, `markStale` and
  `CompatibilityService.check` (EPIC-010).
- The watermark contract and `--full` (EPIC-031,
  `src/cli/commands/index-command.ts:58`).
- The `index-integrity` health component and `HealthReport` (EPIC-004, EPIC-032).
- `UNRESTRICTED_READ` (`src/storage/evidence.ts:76`), the named unrestricted read
  EPIC-083 created for *"the indexer, the reconciler and an integrity sweep."*

## 6. Outputs

- Verification functions on the entity, relationship and evidence stores, and a
  sweep that composes them.
- A run record written before a run writes anything, closed when it finishes.
- An `index-integrity` component reporting real findings across every artefact
  kind, with a remediation that is a command.
- Findings and repair outcomes in `ferret status`, `ferret doctor` and the CLI
  affordance §3.6 names.
- `index.integrity` log events (Governance §20).

## 7. Dependencies

EPIC-002, EPIC-004, EPIC-006, EPIC-007, EPIC-008, EPIC-009, EPIC-010, EPIC-031,
EPIC-032 — all VALIDATED. EPIC-069 for confirmation of a destructive repair;
EPIC-083 for the scoped-read contract.

## 8. Contracts

### Detection reads; repair re-derives

Two verbs, never fused. A sweep that repaired as it went would make its report
unreproducible, and an operator who cannot see the finding before the fix cannot
tell a real problem from a bug in the checker. `verify` is pure and read-only;
`repair` re-reads from source through the same indexer path that wrote the rows
in the first place.

### Repair is re-derivation, never a row edit

The only correct fix for a row that disagrees with its hash is a fresh
observation of the source, superseding it. Editing the row to match the hash — or
the hash to match the row — launders a corruption into a fact, which Governance
§6 treats as worse than an absence. This is why `E_EVIDENCE_TAMPERED` is a
*finding* rather than an error to swallow (`src/storage/evidence.ts:449-451`).

### A check that cannot run reports `unknown`, never `ok`

The stance `src/storage/provider.ts:339-347` already takes, extended to every new
finding. Manufacturing certainty is the failure mode Governance §6 exists to
prevent, and an integrity checker is the worst possible place to introduce it.

### A bound that was hit is reported, not applied silently

`verifyAll`'s `limit: 1_000` is the shape to avoid: a partial answer presented as
a whole one. Every sweep reports how much it examined, how much it did not, and
why it stopped — the discipline EPIC-032 applied to truncated tree listings, where
a partial observation is allowed to conclude nothing.

### The run journal records intent before effect

A row written before the first stage and closed after the last. An open row whose
process is gone is the definition of a partially applied run, and it is the only
way to distinguish "nothing was indexed" from "indexing died". It is *not* a
derived artefact: `derived_artifact` holds one current row per `(kind, scope_id)`
(`src/storage/schema/derived.ts:64`), which is correct for a watermark and wrong
for a history of attempts.

### An integrity sweep says `UNRESTRICTED_READ` out loud

It reads back what Ferret itself wrote and must see all of it. EPIC-083 already
named this caller (`src/storage/evidence.ts:63`); arriving at unrestricted by
omitting the parameter is precisely what that Epic closed.

## 9. Acceptance criteria

**Detection**

- **AC-1** An entity row whose stored content no longer matches its
  `content_hash` is reported, with its id, kind and canonical key. A row altered
  by direct SQL is the test.
- **AC-2** The same for a relationship row.
- **AC-3** A row whose `id` is not `canonicalId(canonical_key)` is reported —
  identity is recomputable, and a re-pointed row is a corruption.
- **AC-4** A tampered evidence row is reported by the sweep, not only by a per-id
  `verify` that a caller must already suspect is needed.
- **AC-5** The sweep covers the whole installation, is bounded, and states what
  it examined and what it did not. A store larger than any internal cap never
  reports a partial result as complete.
- **AC-6** An index run that started and did not finish is detectable after the
  process is gone, and is reported distinctly from "nothing has been indexed".
- **AC-7** A derived artefact of *any* kind built by a superseded producer,
  producer version or entity schema version is marked stale and reported —
  `content-index` included.
- **AC-8** `index-integrity` reports these findings with counts and scope, and
  reports `unknown` — never `ok` — when the check could not run.
- **AC-9** A clean installation yields no findings, and a repeat sweep over an
  unchanged database yields the same result.

**Recovery**

- **AC-10** Every finding carries a remediation naming a Ferret command. No
  finding's remediation is SQL, a table name, or a connection string
  (Governance §13).
- **AC-11** Repair of a scope re-reads it from source and supersedes what was
  wrong. No repair path issues an `UPDATE` against `content_hash`,
  `integrity_hash`, or an evidence observation.
- **AC-12** A repair is idempotent: running it twice writes nothing the second
  time (Governance §10).
- **AC-13** A repair interrupted part way leaves the index no worse than it found
  it, and advances no watermark it did not earn (EPIC-031 AC-6).
- **AC-14** Verification runs without repairing, and repair is scopeable to one
  repository.
- **AC-15** A repair that discards or supersedes existing state is confirmed
  before it runs (EPIC-069).
- **AC-16** After repair, the finding that caused it is gone, proved by re-running
  detection.
- **AC-17** Integrity reads pass `UNRESTRICTED_READ` explicitly; a test asserts
  that no integrity path reaches a store by omitting the scoped-read parameter
  (EPIC-083 AC-2).

## 10. Test requirements

- **Integration against real infrastructure.** Every criterion is a property of
  real PostgreSQL rows; a mocked store would assert only that a mock was called.
  EPIC-008 set the bar by altering a row with direct SQL
  (`validation/EPIC-008-VALIDATION.md:24`) — the same technique proves AC-1 to
  AC-4.
- **Corruption fixtures by direct SQL**, one per finding kind: altered
  attributes, altered relationship metadata, re-pointed id, altered evidence
  statement, artefact with a superseded producer version.
- **A partial-run test that kills the run**, then asserts AC-6 — the database
  reports an unfinished run rather than "nothing has been indexed".
- **Bound reporting proved by violating it**: a sweep over a store larger than its
  cap must report the cap, not a clean bill of health. This is the failure mode
  most worth a dedicated test, because it looks exactly like success.
- **Repair proved end to end**: corrupt, detect, repair, detect again, assert zero
  findings, and assert a third run writes nothing.
- **Negative test on the repair path**: no `UPDATE` touches an observation or a
  hash column, enforced the way EPIC-031 enforces its core/storage boundary.
- **Dogfooding**: a sweep over Ferret's own index reports zero findings, through
  the CLI rather than through SQL.

## 11. Security requirements

- Integrity reads are internal and unrestricted by design, so they are named
  (`UNRESTRICTED_READ`) rather than reached by omission — EPIC-083.
- A finding names ids, kinds and counts. It never echoes a statement, an attribute
  value or a path that could carry a secret; EPIC-082 redacts at ingestion, and a
  diagnostic must not become the surface that reverses that.
- Every identifier reaching a sweep query is a bind parameter.
- A sweep is scoped by repository where a scope is given, and cannot be induced by
  repository content to report on, or repair, another repository.
- Repair is a write path, so it passes `assertSafeToWrite`
  (`src/storage/compatibility.ts:127`) and, where it supersedes state, EPIC-069's
  confirmation.

## 12. Observability

`index.integrity` events carry the sweep's scope, what was examined, what was
skipped and why, and the count of findings by kind. A repair logs what it re-read
and what it superseded. A sweep that found nothing logs that it ran — silence and
health must not look the same to an operator, the point EPIC-032 §12 made about
skipped lifecycle sweeps.

## 13. Performance constraints

- A sweep over an unchanged installation must be bounded and resumable, and must
  not be the reason an operator stops running `ferret doctor`. `status` and
  `doctor` stay fast: the deep sweep is opt-in, and the health component reports
  the last sweep's result rather than performing one.
- Detection is one indexed pass per table; repair costs a re-read of the affected
  scope only, never of the installation.

## 14. Definition of Done

Verification for entities, relationships and evidence; the sweep; the run journal;
staleness marking with its first production caller; the CLI affordance;
`index-integrity` reporting real findings. All acceptance criteria pass against
real PostgreSQL and real `git`; `npm run verify` green; the dogfooding sweep over
Ferret's own index reports zero findings; `validation/EPIC-004-VALIDATION.md`'s
"degraded index — NOT APPLICABLE" is converted with evidence; the three parked
records (`Checkpoints/EPIC-004.md:110`, `Checkpoints/EPIC-010.md:112`,
`COMPATIBILITY.md:162`) are discharged or re-parked with a reason; limitations
recorded.

## 15. Governance alignment

- **§6 Evidence Before Inference** — a corruption is reported, never laundered
  into a fact; a check that cannot run reports `unknown`.
- **§10 Time and History** — repair is idempotent, measured in rows.
- **§13 Reliability** — the clause this Epic exists for: corrupt or stale derived
  indexes detectable and recoverable, without a DBA. Hence AC-10.
- **§18 Provenance** — a superseding observation is attributed to the run that
  made it.
- **§20 Observability** — a sweep that found nothing still says so.
- **§21 Versioning and Reproducibility** — staleness is decided by producer,
  producer version and schema version, across every artefact kind.

## 16. Raised, not absorbed

Decisions taken here that no record dictated. Each is reversible, and none expands
the registry entry.

1. **Governance §13 says "derived indexes"; entities and relationships are
   canonical, not derived.** Read literally, §13 covers `derived_artifact` and the
   content index only. This spec reads it as covering the graph those artefacts
   describe, on the grounds that "the watermark is trustworthy and the rows it
   points at are not" is a distinction without operational value. If governance
   prefers the narrow reading, AC-1 to AC-3 move out and this Epic shrinks to
   artefact staleness. **This is the one governance-level call in the spec.**
2. **The CLI verb is unnamed.** §3.6 and AC-14 require verify-without-repair and
   scoped repair; no record names `ferret verify`, `ferret repair`, or
   `ferret doctor --deep`. Left to implementation, which should prefer extending
   `doctor` over adding a top-level verb (Governance §2).
3. **The run journal is a new table, not a `derived_artifact` row.**
   `derived_artifact`'s unique `(kind, scope_id)` index
   (`src/storage/schema/derived.ts:64`) permits one current row per scope, which
   cannot hold a history of attempts. EPIC-031 chose a derived artefact for the
   watermark and was right; the reasoning does not carry here.
4. **Entity and relationship verification recomputes the existing `content_hash`**
   rather than adding a second, integrity-specific column. It needs no migration,
   and the hash already covers everything mutable
   (`src/domain/entity.ts:256-263`). The cost is that the change-detection hash
   and the integrity hash become one value, so a future change to either is a
   change to both — EPIC-008 recorded the equivalent hazard at
   `Checkpoints/EPIC-008.md:106`.
5. **EPIC-032's reference-lifecycle gap is not reopened.** An integrity sweep is
   the obvious place to retire a branch absent from an enumeration, and doing so
   would apply to refs the inference-from-absence rule EPIC-032 refused for files.
   Declined; it stays with EPIC-037/038.
6. **`verifyAll`'s 1,000-row cap is treated as a defect this Epic fixes**, not as
   an intended bound. No record states the intent either way; AC-5 supersedes it
   regardless.
