# Development Checkpoint — EPIC-008

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-008 — Evidence & Provenance Model (P0, Canonical Knowledge Model)

**Objective:** Every important fact traceable to source evidence, with observed
evidence distinguished from derived knowledge.

**Branch:** `feat/epic-008-evidence-and-provenance-model`, cut from `main` at
`5662c57`.

**Epic status:** VALIDATED — 6/6 acceptance criteria PASS, 7/7 required tests
PASS. One Definition-of-Done item is recorded **PARTIAL** with the reason (no
retrieval layer exists yet to consume the contracts). Evidence in
[`docs/EPICs/validation/EPIC-008-VALIDATION.md`](../EPICs/validation/EPIC-008-VALIDATION.md).

---

## Completed

- **Append-only evidence**, immutable in content, with Ferret's interpretation
  (`state`, `superseded_by`) kept separately and excluded from the integrity hash.
- **Six methods**, with `generated` distinct so model output is never conflated
  with observation.
- **Mandatory derivation citations** for inferred, generated and aggregated
  facts, enforced by validation *and* a foreign key.
- **Producer and version on every record**, so a parser upgrade produces a new
  observation rather than overwriting the old one.
- **Not-knowing represented**: five states, `partial` completeness, and
  confidence where absent ≠ zero.
- **Provenance walked both ways** — backwards to explain, forwards to re-extract
  — depth-limited against cycles.
- **Integrity verification**, single and sweep, raising `E_EVIDENCE_TAMPERED`.
- **Staleness** by source-content hash, reported honestly as unknown when there
  is no hash to compare.
- **Conflict detection** that never resolves by discarding, and a preference
  function that says "cannot choose" rather than guessing.
- **Secret masking** before storage, with the fact retained and the value gone.
- **Permission-scoped reads**, filtered in the query.
- **Migration 0004**, generated and reviewed.

## Files

```text
src/domain/evidence.ts               model, methods, states, identity, integrity, conflicts
src/storage/schema/evidence.ts       evidence + evidence_derivation tables
src/storage/evidence.ts              EvidenceStore
src/storage/migrations/0004_evidence.sql

tests/unit/evidence.test.ts                            37 cases
tests/integration/domain/evidence-store.test.ts        30 cases
```

Modified: `src/errors/codes.ts` (`E_EVIDENCE_INVALID`, `E_EVIDENCE_TAMPERED`),
`src/errors/redact.ts` (**the redaction fix — see below**), `src/cli/exit-codes.ts`,
`src/domain/index.ts`, `src/index.ts`, `src/storage/index.ts`,
`tests/unit/redact.test.ts` (6 regression cases).

## Tests

`npm run verify` — **712 passed, 3 skipped** across 32 files, zero unhandled
errors. `npm audit` — **0 vulnerabilities**.

## Decisions

Full rationale in [`docs/Architecture/EPIC-008-DECISIONS.md`](../Architecture/EPIC-008-DECISIONS.md).

- **D-001** content is immutable; interpretation is not
- **D-002** a derived fact must name what it was derived from
- **D-003** `generated` is its own method
- **D-004** absent confidence is not zero confidence
- **D-005** identity covers the producer and its version
- **D-006** provenance is a join table, walked in both directions
- **D-007** conflicts are detected, never resolved here
- **D-008** secrets are masked, not dropped
- **D-009** permission scope travels with the evidence
- **D-010** a redaction gap found here, fixed for everything
- **D-011** the locator is deliberately open

## The defect this Epic found in shared code

**`DATABASE_PASSWORD=hunter2` was not being redacted.** The pattern was anchored
on `\b(password|…)`, and `\b` does not match after an underscore — so
`DATABASE_PASSWORD=`, `PG_PASSWORD=`, `GITHUB_TOKEN=` and
`FERRET_DATABASE_PASSWORD=` all passed through unredacted.

Those are exactly the shapes secrets take in the environment Ferret runs in, and
because logs, errors and configuration output all redact through the same
function, the gap was never specific to evidence. Fixed and covered by six
regression cases in `redact.test.ts`.

## Notes for whoever picks this up

- **Never update an evidence row's content.** `record()` is append-only by
  design; `supersede()` and `markStale()` touch only Ferret's interpretation. A
  new observation is a new record.
- **`integrityHashOf` must stay aligned with what the row stores.** Adding a
  column to the immutable half means adding it there too, or every existing row
  fails verification.
- **Do not add a resolution policy here.** EPIC-045 owns authority and EPIC-047
  owns conflict handling. `preferredEvidence` deliberately returns `undefined`
  when it cannot distinguish candidates; making it guess would be a regression.
- **Permission filtering is opt-in at the call site.** EPIC-058 must make it
  mandatory on the retrieval path — an internal caller omitting it is correct,
  a retrieval caller omitting it is a leak.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- No retrieval layer consumes evidence yet; contracts exercised directly → **EPIC-048**, **EPIC-052**–**058**
- Authority is stored with no policy behind it → **EPIC-045**
- Confidence is stored but never computed → **EPIC-046**
- Conflicts are detected but nothing writes the `conflicting` state → **EPIC-047**
- Permission scopes are opaque strings → **EPIC-058**, **EPIC-083**
- Staleness must be checked by a caller; nothing sweeps → **EPIC-078**
- Secret detection is shape-based, not entropy-based → **EPIC-082**
- Evidence is never pruned → **EPIC-088**

## Next step

**EPIC-009 — Identity & Scope Model**, then **EPIC-010 — Schema Versioning &
Compatibility**. Those two close the Canonical Knowledge Model domain.

EPIC-009's substrate mostly exists: `developer` and `agent` are already distinct
entity kinds, `branch` and `worktree` are already distinct, external identity
mappings are already a table, and `ferret.instance` from EPIC-002 migration 0001
is the anchor to build on rather than replace. What it must add is
*reconciliation* — mapping several external identities onto one canonical
identity **with auditable evidence** (which is now available), detecting
collisions rather than silently merging, and retaining identity history when a
mapping changes. Note "concurrent reconciliation" is an explicit test
requirement, so the design must assume two providers reconciling at once.

EPIC-010 owns the compatibility rules that EPIC-006 D-014 and EPIC-002 defer to
it: an explicit persisted schema version exists in three places now (database
schema, entity envelope, config file), each currently refusing anything newer.
EPIC-010 must turn "refuse" into a stated compatibility matrix with tested
upgrade paths.

## Addendum — 2026-09-02, after EPIC-047

**"Conflicts are detected but nothing writes the `conflicting` state" is closed.**
The list above is left as written.

`EvidenceState.CONFLICTING` is now written and, more importantly, **cleared**:
`EvidenceStore.reconcileConflicts` marks every member of a genuine group and
returns a record to `current` when the group it was in no longer exists. An index
run reconciles the subjects it recorded new evidence about, so the state is
maintained rather than left to whoever remembers to ask — which is why it was
unreachable for five Epics.

Underneath it was a sharper defect than the checkpoint recorded. **Nothing called
`EvidenceStore.supersede`**, so a changed value left both readings `current` and
`detectConflicts` read the pair as a disagreement. Measured on Ferret's own
index: two groups, both `branch.attributes.headCommit`, one with twenty current
records, and `ferret_why` on `main` reporting a twenty-way conflict about where
`main` points. `record()` now supersedes the prior reading in the transaction
that writes the new one, and a conflict is defined as disagreement **between
sources** — one source restating a field is supersession, which is the rule
EPIC-057 §8.4 had already settled for `preferredEvidence`.

Measured after: **0 conflict groups**, 20 records superseded.

The checkpoint's other instruction still holds and was followed: "Do not add a
resolution policy here." Marking is not resolving — every member of a group is
marked, no side is dropped and no winner is chosen. Governance §15.

Evidence: `docs/EPICs/validation/EPIC-047-VALIDATION.md`.
