# Development Checkpoint — EPIC-004

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-004 — Runtime Health & Diagnostics (P0, Foundation & Runtime)

**Objective:** Give users and AI agents a dependable way to determine whether
Ferret, its database, providers, synchronization and indexes are healthy.

**Branch:** `feat/epic-004-runtime-health-and-diagnostics`, cut from `main` at
`9c6a5dc`.

**Epic status:** VALIDATED — 6/6 acceptance criteria PASS; 7/8 required tests
PASS with one recorded **NOT APPLICABLE** (there is no index yet). Evidence in
[`docs/EPICs/validation/EPIC-004-VALIDATION.md`](../EPICs/validation/EPIC-004-VALIDATION.md).

---

## Completed

- **Health model.** `HealthComponent`, `HealthReport`, `HealthArea`, and an
  aggregation in which `unknown` ranks worse than `degraded` and an optional
  component can never make Ferret unusable.
- **A probe that cannot fail.** Every failure becomes a result, including the
  hardest case — configuration itself failing to parse.
- **Read-only by construction.** `probeHealth` forces `MigrationPolicy.OFF`, so
  checking health can never migrate a schema.
- **`ferret status`.** Component-by-component verdict, human and `--json`,
  `--strict`.
- **`ferret doctor`.** The same report plus an ordered diagnosis per finding,
  each with a stable id and a remediation; `--show-config` renders configuration
  through `describeConfig`.
- **Deterministic exit codes.** 0 usable, 3 configuration, 4 dependency,
  6 schema — attributed to the worst *required* failing component.
- **Honest reporting of what does not exist.** `index-integrity` and
  `synchronization` report `unknown` with the owning Epic named.
- Both commands removed from the `(planned)` list.

## Files

```text
src/diagnostics/health.ts        component and report model, aggregation, summary
src/diagnostics/probe.ts         non-throwing core probe; planned-capability rows
src/diagnostics/doctor.ts        diagnoses, severity, stable ids, ordering
src/cli/health.ts                composition: storage probe + exit-code mapping
src/cli/commands/status.ts       `ferret status`
src/cli/commands/doctor.ts       `ferret doctor`

tests/unit/health.test.ts                                  26 cases
tests/integration/diagnostics/health-cli.test.ts           22 cases
tests/integration/diagnostics/health-database.test.ts      12 cases
```

Modified: `src/diagnostics/index.ts`, `src/index.ts`, `src/cli/program.ts`
(registration + `onExitCode`), `src/cli/main.ts` (honour a reported code),
`src/cli/commands/planned.ts`, `tests/unit/cli.test.ts` and
`tests/integration/cli-process.test.ts` (both asserted `status`/`doctor` were
planned; `mcp` is now the remaining planned command).

## Tests

`npm run verify` — lint, typecheck, build, **492 passed, 3 skipped** across 25
files (the 3 are EPIC-001's POSIX-signal cases, skipped on Windows).

`npm audit` — **0 vulnerabilities**. No new dependencies.

## Decisions

Full rationale in [`docs/Architecture/EPIC-004-DECISIONS.md`](../Architecture/EPIC-004-DECISIONS.md).

- **D-001** the diagnostic cannot fail; every failure is a result
- **D-002** health checks are read-only by construction, not by convention
- **D-003** `unknown` is not a synonym for `ok`
- **D-004** an optional component can never make Ferret unusable
- **D-005** the summary headlines the actionable finding, not the worst one
- **D-006** capabilities that do not exist yet are reported, not omitted
- **D-007** the exit code is attributed to what must be fixed
- **D-008** a command may report an exit code without failing (`onExitCode`)
- **D-009** composition lives in the CLI, aggregation in the core
- **D-010** `status` and `doctor` share one probe so they cannot disagree

## Notes for whoever picks this up

- **`plannedCapabilityComponents` in `src/diagnostics/probe.ts` is a to-do list.**
  When EPIC-031 lands, replace `index-integrity` with a real check; when
  EPIC-075/076 land, replace `synchronization`. Leaving them as `unknown` is
  deliberate, not an oversight — see D-006.
- **New provider health flows through `src/cli/health.ts`,** which maps a
  provider's `checkDependencies()` results onto `HealthArea`. EPIC-014 extends
  that mapping; the core does not change.
- **Do not add a repair path to `doctor`.** It advises. Anything that changes
  state is an explicitly requested operation and is governed by EPIC-069.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- No index or synchronization health, because neither exists → **EPIC-031**, **EPIC-094**, **EPIC-075/076**
- No provider health beyond storage, because storage is the only provider → **EPIC-014**
- A long migration lock wait is not a distinct finding; `doctor` reports the symptom → **EPIC-095** resolved it: the error names the holding session and what to do about it
- Health is point-in-time; no metrics, tracing or history → **EPIC-092**
- Health is not yet exposed over MCP; the report is already structured for it → **EPIC-066**, **EPIC-070**
- macOS unvalidated → **EPIC-105**

## Next step

**The Foundation & Runtime domain is now complete** — EPIC-001 through EPIC-005
are all VALIDATED. The critical path moves to the **Canonical Knowledge Model**:

**EPIC-006 — Canonical Entity Model.** It is the first Epic with a real schema,
and therefore the point at which:

- `drizzle-kit` should finally be added as a devDependency (deferred in
  EPIC-002 D-013 because there was nothing to generate migrations from);
- migration `0002` and onward get generated rather than hand-written, dropping
  into `src/storage/migrations/` unchanged (EPIC-002 D-012);
- `readSchemaStatus` and the checksum/drift machinery start doing real work.

EPIC-006 is followed by EPIC-007 (Relationship & Temporal), EPIC-008 (Evidence &
Provenance), EPIC-009 (Identity & Scope) and EPIC-010 (Schema Versioning). Note
that `ferret.instance` already exists from EPIC-002 migration `0001` and is the
anchor EPIC-009 should build on rather than replace.

Toward a usable vertical slice, the chain after the canonical model is:
EPIC-011/012/013 (provider platform) → EPIC-017/018 (repository and worktree
discovery) → EPIC-022/023 (file discovery and identity) → EPIC-031 (incremental
indexing) → EPIC-052/053 (structured and full-text retrieval) → EPIC-059/060/061
(context and answer packs) → EPIC-064/065 (MCP). That is the shortest path to the
first genuinely usable Ferret described in the delivery brief.
