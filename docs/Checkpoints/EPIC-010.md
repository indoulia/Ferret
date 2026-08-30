# Development Checkpoint — EPIC-010

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-010 — Schema Versioning & Compatibility (P0, Canonical Knowledge
Model)

**Objective:** Let Ferret's canonical schema, provider contracts, indexes and
persisted data evolve without corrupting existing knowledge or forcing unsafe
manual migrations.

**Branch:** `feat/epic-010-schema-versioning-and-compatibility`, cut from `main`
at `f420ad6`.

**Epic status:** VALIDATED — 6/6 acceptance criteria PASS, 6/6 required tests
PASS. Evidence in
[`docs/EPICs/validation/EPIC-010-VALIDATION.md`](../EPICs/validation/EPIC-010-VALIDATION.md).

**This completes the Canonical Knowledge Model domain.** EPIC-006 through
EPIC-010 are all VALIDATED.

---

## Completed

- **One compatibility policy** replacing four copies of the same reflex, stated
  in [`docs/Architecture/COMPATIBILITY.md`](../Architecture/COMPATIBILITY.md).
- **Four verdicts** — current, upgradable, too-old, too-new — with `upgradable`
  deliberately *not* safe to write.
- **Upgrade paths tested from every supported prior version**, generically, plus
  a determinism assertion that two starting points reach the same schema.
- **Provider contracts as a stated range** rather than exact equality.
- **A derived-artefact registry** recording what produced an index and at which
  version, with staleness detection that says why.
- **Migration 0006**, generated and reviewed.

## Files

```text
src/domain/compatibility.ts          the policy: surfaces, verdicts, artefact staleness
src/storage/compatibility.ts         reading live versions; derived-artefact registry
src/storage/schema/derived.ts        derived_artifact table
src/storage/migrations/0006_derived_artifacts.sql
docs/Architecture/COMPATIBILITY.md   the matrix, the rules, and how to add a version

tests/unit/compatibility.test.ts                        22 cases
tests/integration/storage/compatibility.test.ts         21 cases
```

Modified: `src/providers/contract.ts` and `registry.ts` (contract range),
`src/storage/connection.ts` (**the error-unwrap fix — see below**),
`src/domain/index.ts`, `src/index.ts`, `src/providers/index.ts`,
`src/storage/index.ts`, `tests/unit/storage.test.ts` (3 regression cases).

## Tests

`npm run verify` — **807 passed, 3 skipped** across 36 files, zero unhandled
errors. `npm audit` — **0 vulnerabilities**.

## Two defects this Epic found in shared code

1. **Compatibility checking crashed on a partially migrated database** — reading
   the entity envelope version failed when the `entity` table did not exist yet,
   which is exactly when an operator most needs the answer.
2. **Every error arriving through Drizzle was losing its classification.**
   Chasing the first revealed the larger problem: Drizzle wraps a failing query
   and puts the `pg` error in `cause`, so `error.code` found nothing. Every error
   on a Drizzle path — entity, relationship, evidence and identity stores, all of
   EPIC-006 onwards — fell through to generic `E_STORAGE_UNAVAILABLE`, discarding
   the SQLSTATE, the classification and the remediation EPIC-002 built. A
   permission failure, a missing table and an unreachable server all reported the
   same thing. Fixed by walking the `cause` chain in `errorCodeOf`.

Second time a shared error-handling defect has surfaced from a later Epic's tests
(EPIC-008 found the redaction gap). Both were invisible while every test passed.

## Notes for whoever picks this up

- **`assertSafeToWrite` is available but not yet wired into ingestion**, because
  there is no ingestion. **EPIC-031 must call it at the indexing entry point** —
  that is the point of AC-3, and leaving it uncalled makes the guarantee
  theoretical.
- **Adding a versioned surface** means a row in COMPATIBILITY.md §1 *and* an
  entry in `SURFACE_POLICIES`; a test asserts the two stay in step.
- **Do not compare producer versions as semver.** A producer version may be a
  semver, a git sha or a model name, and Ferret cannot know whether a change was
  breaking. Any difference marks the artefact stale — the only direction that
  cannot serve an irreproducible result.
- **Raising `MINIMUM_PROVIDER_CONTRACT_VERSION` or any `minimumSupported` drops
  support for existing installations.** Release note, not refactor.
- **`errorCodeOf` walks the cause chain.** Any new query layer that wraps errors
  is handled; do not reintroduce a direct `error.code` read.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- Only one version exists per surface, so no *real* incompatibility has been
  exercised — only synthetic ones
- Nothing rebuilds a stale derived artefact → **EPIC-031**, **EPIC-054**, **EPIC-094**
- `assertSafeToWrite` is not yet called on a write path → **EPIC-031**
- Downgrade recovery needs a backup Ferret cannot yet take → **EPIC-089**, **EPIC-090**
- The live aggregate reads the two database-resident surfaces; config and
  provider versions are checked by their own subsystems
- No user-facing upgrade experience → **EPIC-106**
- macOS unvalidated → **EPIC-105**

## Next step

**The Canonical Knowledge Model is complete.** Ten Epics are VALIDATED
(EPIC-001–010), covering the runtime, storage, configuration, diagnostics, and
the entity, relationship, evidence, identity and versioning models.

The critical path now moves to the **Provider Platform** — EPIC-011 (Provider
Contracts), EPIC-012 (Provider SDK), EPIC-013 (Provider Registry & Discovery),
EPIC-015 (Provider Configuration & Secrets) and EPIC-016 (Provider Conformance
Testing). Much of EPIC-011 already exists as the EPIC-001 `Provider` contract
plus the version range added here; EPIC-011's job is to widen it into the
capability-shaped contracts a source provider actually needs, and EPIC-016 to
give every provider a conformance suite it must pass.

After the provider platform, the shortest route to a usable Ferret is:
EPIC-017/018 (repository and worktree discovery) → EPIC-022/023 (file discovery
and identity) → EPIC-031 (incremental indexing — and the place to wire
`assertSafeToWrite`) → EPIC-052/053 (structured and full-text retrieval) →
EPIC-059/060/061 (context and answer packs) → EPIC-064/065 (MCP).
