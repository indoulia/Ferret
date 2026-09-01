# Development Checkpoint — EPIC-003

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-003 — Configuration Engine (P0, Foundation & Runtime)

**Objective:** One secure configuration system that makes ordinary Ferret setup
require only database details and optional repository exclusions.

**Branch:** `feat/epic-003-configuration-engine`, cut from `main` at `31b3732`.

**Epic status:** VALIDATED — 8/8 acceptance criteria PASS, 8/8 required tests
PASS, evidence in [`docs/EPICs/validation/EPIC-003-VALIDATION.md`](../EPICs/validation/EPIC-003-VALIDATION.md).

---

## Completed

- **The full Governance §16 ladder.** Defaults → environment → user file →
  repository policy → session → explicit operation, assembled once in
  `sources.ts` so every entry point behaves identically. The runtime now uses it
  by default instead of environment variables alone.
- **Persistence.** `ConfigStore` does locked, validated, atomic read-modify-write
  with a change journal. Concurrent writers cannot lose an update; a crash cannot
  leave a torn file.
- **Repository policy.** `.ferret/config.json`, discovered by walking upward,
  restricted to `exclude` only — the security decision of the Epic.
- **Secret references.** `{"$secret":{"env":…}}` / `{"$secret":{"file":…}}`,
  resolved before validation so nothing downstream sees two shapes.
- **Exclusions.** Rules with scope, reason and `effectiveFrom`; glob matching via
  `picomatch`; Ferret's own defaults; a pure evaluator that cannot delete.
- **Provider configuration.** Shape validated in core, meaning left to providers.
- **Change auditing.** Append-only NDJSON beside the config file, recording what
  changed and by whom, never a secret and never a previous value.
- **`ferret config`.** `list` (with `--explain`), `get`, `set`, `unset`,
  `validate`, `path`, `exclude list|test`, `audit` — all `--json`, all with
  stdout as exactly one JSON document. Removed from the `(planned)` list.
- **`ferret init --save`.** Persists the proven connection so it need not be
  supplied again.
- **Config file format version**, with a newer file refused rather than misread.

## Files

```text
src/config/paths.ts              platform config locations, repository discovery
src/config/secret-ref.ts         secret reference model and resolution
src/config/exclusions.ts         rules, scopes, matcher, defaults, evaluator
src/config/file-source.ts        user file layer, parsing, version handling
src/config/repository-source.ts  repository policy layer + trust boundary
src/config/session-source.ts     session and explicit-operation layers
src/config/sources.ts            the default layer stack
src/config/store.ts              lock, atomic write, validate-before-activate
src/config/audit.ts              change journal
src/config/schema.ts             extended: exclusions, providers, file version
src/config/resolve.ts            precedence, origins, secret resolution
src/cli/commands/config.ts       `ferret config`

tests/unit/config-layers.test.ts               39 cases
tests/integration/config/persistence.test.ts   30 cases
tests/integration/config/config-cli-*.test.ts  26 cases
tests/fixtures/concurrent-config-writer.mjs    cross-process lock exercise
```

Modified: `src/index.ts` (public surface), `src/runtime/runtime.ts` (default
layer stack), `src/cli/commands/init.ts` (`--save`), `src/cli/program.ts`,
`src/cli/commands/planned.ts`, `tests/global-setup.ts` (isolated
`FERRET_CONFIG_HOME`), `tests/unit/boundaries.test.ts`, `tests/unit/config.test.ts`,
`tests/integration/storage/init-cli.test.ts`, `package.json` (`picomatch`).

## Tests

`npm run verify` — lint, typecheck, build, **430 passed, 3 skipped** across 22
files (the 3 are EPIC-001's POSIX-signal cases, skipped on Windows).

`npm audit` — **0 vulnerabilities**.

The suite is now hermetic with respect to configuration: `tests/global-setup.ts`
points `FERRET_CONFIG_HOME` at a temporary directory for the whole run, so no
test can read or write the configuration of whoever runs it. **Any new test that
spawns Ferret must inherit that env**, or it will pick up the developer's machine.

## Decisions

Full rationale in [`docs/Architecture/EPIC-003-DECISIONS.md`](../Architecture/EPIC-003-DECISIONS.md).

- **D-001** repository policy may set only `exclude` — the Epic's security decision
- **D-002** exclusion is additive and one-way, which is what makes D-001 safe
- **D-003** exclusions are a decision, never an action; no deletion path exists
- **D-004** secret references are an object, not a `"env:VAR"` string convention
- **D-005** the user file outranks environment variables (Governance §16 as written)
- **D-006** writes are locked, validated, then atomic — in that order
- **D-007** a lock abandoned by a crashed process is broken by age
- **D-008** the audit journal never records a secret or a previous value
- **D-009** the config file carries a format version; a newer one is refused
- **D-010** `picomatch` for glob matching rather than a hand-written matcher
- **D-011** `init --save` persists the password, only after proving it works
- **D-012** the boundary scanner reads code, not prose
- **D-013** configuration layers deep-copy on read and write

## Two defects found by the new tests

- **A session layer could be mutated through its own result.** A shallow copy left
  nested objects shared, so configuration could change underneath the process
  that had resolved it. Fixed with `structuredClone` (D-013).
- **The architecture boundary scanner could be fooled by prose.** A doc comment
  containing `from "unreadable"` registered a phantom dependency, and a help
  string ending in *from* swallowed several lines. Fixed by stripping comments
  and validating specifier shape (D-012) — strengthening a control EPIC-001 and
  EPIC-002 both rely on.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- `0600` is not enforced on Windows; the file inherits the directory ACL → **EPIC-081** reports it in `ferret doctor` rather than resolving it; the platform is unchanged
- Credentials are stored in a plain file, not an OS keychain → **EPIC-081** delivered the resolver seam and stopped `--save` flattening a `$secret` reference; no keychain backend is registered
- The audit journal is never rotated → **EPIC-085**
- Repository policy may set only `exclude`; widening it is a security decision
- No schema export for AI clients; agents use `get`/`set` → **EPIC-066**
- Exclusions are modelled and evaluated, but not yet applied at discovery or
  retrieval time → **EPIC-022**, **EPIC-058**
- macOS unvalidated → **EPIC-105**

## Next step

**EPIC-004 — Runtime Health & Diagnostics.** Its dependencies are satisfied and
most of its inputs already exist:

- `DependencyCheck` / `DependencyStatus` (EPIC-001) with `ok` / `degraded` /
  `unavailable` / `unknown` already distinguished;
- the storage provider's four health results (EPIC-002), including pending
  migrations, recorded migration failures, schema drift, an unsupported schema
  version and pgvector availability;
- configuration introspection and origins (EPIC-003), so `doctor` can say *which
  layer* supplied a bad value.

`ferret status` and `ferret doctor` are still `(planned)` and exit 5. `doctor`
should surface, with remediation: no database configured; database unreachable;
bad credentials; PostgreSQL older than 14; pending or failed migration; schema
drift; an unsupported schema version; a long migration lock wait (the D-006 gap
recorded in EPIC-002 — `client_connection_check_interval` is a no-op on a
Windows-hosted server); pgvector absent; `git` missing from `PATH`; and an
unreadable or invalid configuration file.

Both commands must be machine-readable and must not mutate — EPIC-002's
`readSchemaStatus` and `MigrationPolicy.OFF` already provide read-only paths.

After EPIC-004, **EPIC-006 — Canonical Entity Model** is the critical path toward
a usable vertical slice, and the point at which `drizzle-kit` should be added.
