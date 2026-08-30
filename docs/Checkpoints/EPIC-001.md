# Development Checkpoint — EPIC-001

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-001 — Core Runtime & Package (P0, Foundation & Runtime)

**Objective:** Deliver the minimal installable Ferret runtime and a stable
application boundary that later Epics extend without breaking.

**Branch:** `feat/epic-001-core-runtime`, cut from `main` at `890aa49`.
**Merged:** PR #2, squashed to `main` as `4cbead2`.
**Epic status:** VALIDATED (not DONE — see Blockers).

---

## Completed

- **Package.** `@indoulia/ferret`, ESM, Node ≥ 22, `bin: ferret`, `files`
  allowlist restricted to `dist`, `README.md`, `LICENSE`. Build is `tsc` only.
- **Runtime.** `FerretRuntime` with the full lifecycle — resolve config, build
  logger, detect environment, validate dependencies, initialize providers, ready,
  shutdown. Idempotent and concurrency-safe in both directions; terminal after
  stop; releases everything on a failed start.
- **Errors.** `FerretError` with 14 stable codes, redaction applied at
  serialization, cause chains, remediation text, and a total mapping to exit
  codes.
- **Redaction.** Key-name, value-shape and embedded-credential redaction, with
  cycle and depth protection.
- **Logging.** Pino-backed NDJSON on stderr, `warn` by default, every record
  redacted before it reaches the stream.
- **Configuration boundary.** `ConfigSource` layers with the Governance §16
  precedence ladder; environment source only; zero-config start; redacted
  introspection via `describeConfig`.
- **Provider boundary.** One versioned contract, six kinds
  (storage/index/source/parser/mcp/embedding), registry with validation,
  ordered lifecycle, failure isolation.
- **Diagnostics boundary.** `DependencyCheck` contract with
  ok/degraded/unavailable/unknown; core checks for Node version (required) and
  Git (optional).
- **CLI.** `version` and `env` implemented; `init`, `config`, `status`, `doctor`
  and `mcp` listed as `(planned — EPIC-0NN)` and failing with
  `E_NOT_IMPLEMENTED` / exit 5. Exit-code contract 0/1/2/3/4/5/130/143.
- **Signals.** `SIGINT`/`SIGTERM` → graceful shutdown, second signal exits
  immediately, unref'd grace timer.
- **Tests.** 13 files, 256 cases. Integration tests use the real artefact:
  `npm pack`, `npm install -g`, spawned processes, real OS signals.
- **CI.** `.github/workflows/ci.yml` — lint, typecheck, build, test, baseline on
  `ubuntu-latest` and `windows-latest`; separate dependency-audit job.
- **Docs.** `README.md`, `docs/Architecture/RUNTIME.md`,
  `docs/Architecture/EPIC-001-DECISIONS.md`,
  `docs/EPICs/validation/EPIC-001-VALIDATION.md`,
  `docs/Performance/EPIC-001-baseline-win32.json`.

## Files changed

```text
package.json  package-lock.json  tsconfig.json  tsconfig.build.json
eslint.config.js  vitest.config.ts  .gitignore  LICENSE  README.md
.github/workflows/ci.yml
scripts/clean.mjs  scripts/baseline.mjs

src/index.ts  src/version.ts
src/errors/{codes,ferret-error,redact,index}.ts
src/logging/{logger,index}.ts
src/config/{schema,resolve,index}.ts
src/environment/{detect,index}.ts
src/diagnostics/{contract,checks,index}.ts
src/providers/{contract,registry,index}.ts
src/runtime/{lifecycle,disposables,runtime,signals,index}.ts
src/cli/{main,program,output,exit-codes}.ts
src/cli/commands/{version,env,planned}.ts

tests/global-setup.ts  tests/helpers/cli.ts  tests/fixtures/long-running.mjs
tests/unit/{version,redact,errors,config,environment,logging,providers,runtime,boundaries,cli}.test.ts
tests/integration/{cli-process,signals,packaging}.test.ts

docs/Architecture/{RUNTIME,EPIC-001-DECISIONS}.md
docs/EPICs/validation/EPIC-001-VALIDATION.md
docs/Performance/EPIC-001-baseline-win32.json
docs/EPICs/EPIC-001-Core-Runtime-and-Package.md   (status line + evidence link only)
```

## Tests and verification

Windows 11, Node 22.23.2, npm 10.9.8:

```text
Lint       PASS  (0 problems)
Typecheck  PASS  (0 errors)
Build      PASS
Tests      PASS  (13 files, 253 passed, 3 skipped)
Packaging  PASS  (pack, byte-identical repack, global install, smoke)
Audit      PASS  (0 vulnerabilities, 147 packages)
Baseline   recorded → docs/Performance/EPIC-001-baseline-win32.json
```

The 3 skipped cases are real-signal tests, skipped on Windows by design and run
on `ubuntu-latest` in CI.

Reproduce with `npm run verify`, or individually:
`npm run lint`, `npm run typecheck`, `npm run build`, `npm test`,
`npm run baseline`.

Note for anyone running tests from Git Bash on Windows: the packaging tests
invoke npm's generated `ferret.cmd`, which needs a native-form `PATH`. Git Bash
exports a POSIX-form `PATH` that `cmd.exe` cannot parse, so run the suite from
PowerShell or `cmd` on Windows. This affects the test harness only, not Ferret.

## Decisions

Recorded in full in `docs/Architecture/EPIC-001-DECISIONS.md`:

- **D-001** package name `@indoulia/ferret` — unscoped `ferret` is taken on npm
- **D-002** version starts at `0.1.0`, `publishConfig.tag: next`
- **D-003** TypeScript pinned to 6.0.x (typescript-eslint peer range excludes 7)
- **D-004** `tsc` only, no bundler
- **D-005** storage/index/mcp are provider *kinds*, not separate stacks
- **D-006** a runtime instance is single-use
- **D-007** redaction applied at serialization, not at the call site
- **D-008** `ferret env` reports facts; health verdicts belong to EPIC-004
- **D-009** subprocesses use `execFile`, never a shell
- **D-010** no PostgreSQL integration testing in EPIC-001
- **D-011** MIT `LICENSE` added

## Blockers

None for implementation. One item needs a product decision before the Epic can
move to DONE: AC-1 is written as `npm install -g ferret`, but that unscoped npm
name is permanently unobtainable, so the package ships as `@indoulia/ferret`
with the binary `ferret`. The criterion's substance is delivered and evidenced
(D-001); ratifying the deviation is EPIC-102's call, not the implementation's.

## Known limitations

- macOS unvalidated — no host available, none in CI → **EPIC-105**
- `SIGTERM` undeliverable on Windows (Node limitation) → **EPIC-105**
- Version line `0.1.0` vs published `2.0.0` unreconciled → **EPIC-102**
- Package name deviates from the Epic's literal `ferret` → **EPIC-102**
- No provider discovery; explicit registration only → **EPIC-013**
- Environment is the only configuration source → **EPIC-003**

## Next step

**EPIC-002 — Database Bootstrap & Migrations.** Its dependencies are now
satisfied: EPIC-001 provides the runtime, lifecycle, error model and provider
boundary; EPIC-005 selected Drizzle ORM with `drizzle-kit` as a devDependency.

Concretely, EPIC-002 should:

1. Add a `storage` provider implementing the EPIC-001 `Provider` contract, so
   the runtime gains a database without core changes.
2. Use `isDatabaseConfigured()` / `missingDatabaseFields()` — already exported —
   to fail with an actionable `E_CONFIG_MISSING` when connection details are
   absent.
3. Introduce real PostgreSQL integration testing (Testcontainers or equivalent),
   which EPIC-001 deliberately did not, per D-010.
4. Use `pg_try_advisory_lock` for migration locking; EPIC-005 verified it works
   through Drizzle.
5. Write FTS and pgvector queries as raw `sql` templates, per
   TECHNOLOGY-DECISIONS §3.

EPIC-003 (Configuration Engine) and EPIC-004 (Health & Diagnostics) can proceed
in parallel: both extend contracts EPIC-001 already published — `ConfigSource`
and `DependencyCheck` respectively — without needing EPIC-002.
