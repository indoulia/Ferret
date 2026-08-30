# EPIC-001 — Validation Evidence

**Epic:** EPIC-001 — Core Runtime & Package
**Branch:** `feat/epic-001-core-runtime`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification itself is unchanged. Acceptance criteria were not
reworded to make the implementation appear complete.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | `npm install -g ferret` installs a usable CLI/runtime package | **PASS** — with recorded deviation | `tests/integration/packaging.test.ts` → "global installation" (4 cases): real `npm pack`, real `npm install --global --prefix`, then the installed launcher runs `--help`, `version --json` and `env --json`. **Deviation:** the package is `@indoulia/ferret`; the unscoped npm name `ferret` belongs to an unrelated 2022 package and is unobtainable. The binary is `ferret`, so the criterion's substance holds. See [D-001](../../Architecture/EPIC-001-DECISIONS.md#d-001-published-package-name-is-indouliaferret). |
| AC-2 | Runtime startup is deterministic and reports its version | **PASS** | `tests/unit/version.test.ts` (4 cases: manifest agreement, determinism across calls, no host-identifying data). `tests/integration/cli-process.test.ts` → "is deterministic across repeated startups" compares byte-identical output from two independent processes. |
| AC-3 | Core imports do not depend directly on GitHub/Jira/parser/vendor implementations | **PASS** | `tests/unit/boundaries.test.ts` (22 cases) walks the static import graph from `src/index.ts` and asserts: no `src/cli/**` module is reachable; external dependencies are exactly `pino` and `zod`; `commander` is absent; and 13 provider/vendor name fragments (github, octokit, jira, pdfjs, mammoth, exceljs, tree-sitter, drizzle, postgres, modelcontextprotocol, …) appear nowhere. |
| AC-4 | Startup/shutdown are safe and idempotent | **PASS** | `tests/unit/runtime.test.ts` → "idempotency" (8 cases): repeat initialize, concurrent initialize, repeat shutdown, concurrent shutdown, shutdown without initialize, restart refused, three sequential instance cycles. Plus "initialization failure" (7 cases) proving a failed start leaves no resource open, and "shutdown" (4 cases) proving reverse-order release and failure aggregation. |
| AC-5 | Errors are structured and never expose credentials | **PASS** | `tests/unit/errors.test.ts` (23 cases) and `tests/unit/redact.test.ts` (43 cases). End-to-end proof in `tests/integration/cli-process.test.ts` → "secret safety" (3 cases): a real password in the environment appears in neither stdout nor stderr at `--log-level trace`, nor in a configuration error. |
| AC-6 | Package contents are reproducible and do not contain development secrets | **PASS** | `tests/integration/packaging.test.ts`: "is reproducible — packing twice yields byte-identical tarballs" (SHA-256 comparison); 16 `ships no …` cases (tests, fixtures, sources, spikes, docs, CI config, node_modules, lockfile, `.env`, databases, archives, coverage, tool config, scripts); "ships only dist output plus the three root files"; and 5 secret-shape scans over every installed byte. |

**6 / 6 PASS.** One recorded deviation (AC-1), carried to EPIC-102.

---

## 2. Required tests

The Epic names six test areas. All six exist:

| Required test | Status | Location |
| --- | --- | --- |
| Fresh install | PASS | `packaging.test.ts` → global install into a throwaway prefix |
| Startup / shutdown | PASS | `runtime.test.ts`, `cli-process.test.ts` |
| Malformed configuration | PASS | `config.test.ts` (5 invalid-input cases), `cli-process.test.ts` → exit code 3 |
| Missing optional dependencies | PASS | `environment.test.ts` → Git absent degrades rather than blocks; `runtime.test.ts` → "does not block startup on an optional dependency" |
| Package smoke test | PASS | `packaging.test.ts` → installed binary runs `--help`, `version`, `env` |
| Cross-platform package test | PASS (Windows, Linux) | Windows: run locally, recorded below. Linux: CI matrix `ubuntu-latest`. **macOS not validated** — see limitations. |

### Additional coverage beyond the required list

- Real OS signal delivery (`signals.test.ts`) — POSIX only, see limitations.
- Git-absent detection, forced by pointing `PATH` at an empty directory.
- Stream discipline: stdout stays parseable JSON while logs flow to stderr.
- Exit-code totality: every `ErrorCode` maps to a defined `ExitCode`.
- Provider contract conformance: id validation, kind validation, contract-version
  mismatch, duplicate rejection, ordering, failure isolation.

---

## 3. Verification run

Recorded on Windows 11 (`win32/x64`), Node 22.23.2, npm 10.9.8.

| Gate | Result |
| --- | --- |
| Lint (`eslint .`) | **PASS** — 0 problems |
| Typecheck (`tsc --noEmit`, src + tests) | **PASS** — 0 errors |
| Build (`tsc -p tsconfig.build.json`) | **PASS** |
| Tests | **PASS** — 13 files, 253 passed, 3 skipped |
| Packaging | **PASS** — pack, reproducibility, global install, smoke |
| Dependency audit (`npm audit`) | **PASS** — 0 vulnerabilities, 147 packages |

The 3 skipped tests are the real-signal cases, skipped on Windows by design.

---

## 4. Dependency footprint review

Required by the Definition of Done.

### Production dependencies — 3 direct

| Package | Version | Licence | Why | Alternative rejected |
| --- | --- | --- | --- | --- |
| `commander` | ^15.0.0 | MIT | CLI parsing, help generation, usage errors | Hand-rolled parsing — forbidden by Governance §5 and AI Rule §5 |
| `pino` | ^10.3.1 | MIT | Structured logging | Named as the approved direction in TECHNOLOGY-DECISIONS §1 |
| `zod` | ^4.5.4 | MIT | Configuration schema and validation | Hand-rolled validation — same rule |

All three are MIT, actively maintained, and were already the approved direction
or the obvious reuse choice. No dependency was added for convenience.

`commander` is confined to the CLI layer; `tests/unit/boundaries.test.ts` fails
if it reaches the core.

### Installed footprint

- **147 packages** including all dev dependencies; **0 vulnerabilities**.
- Production tree is `commander`, `pino`, `zod` and their transitives only.
- Contrast with EPIC-005's spike environment (228 packages): the parser and
  tree-sitter dependencies that dominated that count belong to later Epics and
  are not present here.

### Package size

| Measure | Value |
| --- | --- |
| Tarball | 43,090 bytes |
| Unpacked | 139,439 bytes |
| Files | 96 |

Full baselines: `docs/Performance/EPIC-001-baseline-win32.json`.

---

## 5. Performance baseline

Not an optimisation target — a regression baseline, per Governance §17.

| Measurement | Median (win32/x64, Node 22.23.2) |
| --- | --- |
| `ferret --version` (full process) | 608 ms |
| `ferret --help` (full process) | 540 ms |
| `ferret env` (initialize + shutdown) | 843 ms |
| `runtime.initialize()` in process | 274 ms |
| `runtime.shutdown()` in process | 0.1 ms |

The 274 ms initialize is dominated by the `git --version` subprocess probe;
process-level figures additionally carry Node's ~450 ms cold start on Windows.
Neither is optimised here, and neither should be assumed to hold on Linux —
EPIC-005 §11 already records that platform behaviour reverses.

---

## 6. Security review

| Requirement | Status | Evidence |
| --- | --- | --- |
| No secrets in source | PASS | `git diff` reviewed; packaging secret scan over every shipped byte |
| No credentials in logs | PASS | `logging.test.ts` (5 redaction cases); `cli-process.test.ts` secret safety at trace level |
| Safe subprocess invocation | PASS | `execFile` with explicit argv and `shell: false` — [D-009](../../Architecture/EPIC-001-DECISIONS.md#d-009-git-is-invoked-with-execfile-never-a-shell) |
| Safe filesystem handling | PASS | No user-supplied path is opened in EPIC-001 |
| Dependency audit | PASS | 0 vulnerabilities; CI fails on high/critical |
| No arbitrary code execution paths | PASS | No `eval`, no `new Function`, no dynamic `require` of user input |
| No unsafe dynamic evaluation | PASS | Same |

**A real defect was found and fixed during implementation:** top-level log fields
were value-redacted but not key-redacted, so `logger.info({ password: … })`
would have written a credential to the log stream. Found by
`tests/unit/logging.test.ts` → "inherits and redacts child bindings"; fixed in
`src/logging/logger.ts`.

---

## 7. Definition of Done

| Item | Status | Note |
| --- | --- | --- |
| All acceptance criteria pass | **PASS** | 6/6, with AC-1's deviation recorded |
| Package-size / dependency footprint reviewed | **PASS** | Section 4 |
| Public boundaries documented | **PASS** | `docs/Architecture/RUNTIME.md` |
| CI validates the package | **PENDING CI** | `.github/workflows/ci.yml` runs lint, typecheck, build, tests (packaging included) and baseline on `ubuntu-latest` and `windows-latest`, plus a dependency audit job. Marked PASS only once the workflow is green on the PR. |

---

## 8. Known limitations

Recorded rather than glossed over.

| Limitation | Impact | Carried to |
| --- | --- | --- |
| **macOS not validated.** No macOS host was available, and none is in CI. | No macOS support is claimed. | EPIC-105 — already carried from EPIC-005 §11 |
| **`SIGTERM` is undeliverable on Windows.** Node does not support it; `SIGINT` reaches a spawned child only through console emulation. | The three real-signal tests skip on Windows. They run on `ubuntu-latest`. Handler registration failures are tolerated, so startup is unaffected. | EPIC-105 |
| **Version line unreconciled.** `0.1.0` here vs `2.0.0` published. Mitigated by `publishConfig.tag: next`. | An accidental publish cannot take the `latest` tag. | EPIC-102 — [D-002](../../Architecture/EPIC-001-DECISIONS.md#d-002-version-line-starts-at-010-with-publishes-tagged-next) |
| **No PostgreSQL integration testing.** EPIC-001 opens no connection, so there is no database behaviour to test. | Deliberate: adding PostgreSQL solely to have an integration test would be infrastructure for its own sake (Governance §14, §23). | EPIC-002 — [D-010](../../Architecture/EPIC-001-DECISIONS.md#d-010-no-postgresql-integration-testing-in-epic-001) |
| **No provider discovery.** Providers must be registered explicitly. | The registry is shaped to accept discovery without a contract change. | EPIC-013 |
| **TypeScript pinned to 6.0.x.** TS 7 is `latest` but outside typescript-eslint's peer range. | Type-aware linting is retained. | [D-003](../../Architecture/EPIC-001-DECISIONS.md#d-003-typescript-is-pinned-to-60x-not-7x) |

---

## 9. Governance alignment

| Rule | How EPIC-001 satisfies it |
| --- | --- |
| §2 Simplicity is a product requirement | Ferret starts with zero configuration; the mandatory surface is database details plus optional exclusions, and nothing else may become mandatory |
| §4 Provider-first architecture | One versioned provider contract covering storage, index, source, parser, mcp and embedding kinds; the core never names a concrete provider |
| §5 Reuse before reinvent | Commander, Pino and Zod rather than hand-rolled parsing, logging or validation |
| §6 Evidence before inference | `unknown` is a first-class dependency status; a check that cannot run never reports `ok` |
| §12 Security | Redaction at the serialization boundary; `execFile` with no shell; no secrets in source or package |
| §16 Configuration | Precedence ladder implemented with the later rungs reserved for EPIC-003 |
| §17 Performance discipline | Baselines recorded; nothing optimised speculatively |
| §19 Testing and quality | 256 test cases; failure and boundary cases covered; integration tests use the real artefact, not mocks |
| §20 Observability | Structured NDJSON diagnostics separable from human output |
| §21 Versioning | `RUNTIME_CONTRACT_VERSION` and `PROVIDER_CONTRACT_VERSION` are independent of the package version |
| AI Rule §3 Epic scope is a contract | No database, provider, parser, indexing or MCP implementation; only the boundaries the Epic names |
| AI Rule §9 No fake completion | The one deviation and every limitation are recorded above rather than smoothed over |
