# EPIC-001 Implementation Decisions

**Status: RECORDED**
**Effective: 2026-08-30**

Decisions taken while implementing EPIC-001 that affect later Epics, public
contracts or distribution. Recorded per Governance §19 and AI Development Rule
§19, which require architectural decisions to be documented before they become
implicit architecture.

None of these reopens an EPIC-005 technology decision. Where one interacts with
EPIC-005, that is stated.

---

## D-001. Published package name is `@indoulia/ferret`

**Decision.** The package is published as `@indoulia/ferret`, exposing the
binary `ferret`.

**Reason.** EPIC-001's acceptance criterion is phrased as
`npm install -g ferret`. The unscoped name `ferret` on npm is **taken** — it has
belonged to an unrelated MongoDB library since 2022 and is not obtainable. The
scoped name `@indoulia/ferret` is already owned by this project, already
declares `bin: ferret`, and delivers the criterion's substance: a global install
that puts a working `ferret` on `PATH`.

**Consequence.** The install command is `npm install -g @indoulia/ferret`. The
binary name is unchanged, so every documented invocation is exactly as the Epic
describes.

**Carried to EPIC-102 (NPM Distribution)**, which owns publishing and may
revisit the name if the unscoped one becomes available.

---

## D-002. Version line starts at 0.1.0, with publishes tagged `next`

**Decision.** This rebuild starts at `0.1.0`. `publishConfig.tag` is set to
`next`.

**Reason.** `@indoulia/ferret@2.0.0` is already published from the project's
previous incarnation. The current repository is a governed rebuild, not an
increment of that line, so `0.1.0` describes it honestly. But npm assigns the
`latest` dist-tag on publish by default, so publishing `0.1.0` would silently
downgrade existing users. Pinning `publishConfig.tag` to `next` makes an
accidental publish land on a non-default tag.

**Consequence.** Reconciling the `0.x` line against the published `2.0.0` is a
real, open decision — not an oversight.

**Carried to EPIC-102**, which must resolve the version line before a `latest`
release.

---

## D-003. TypeScript is pinned to 6.0.x, not 7.x

**Decision.** `typescript: ~6.0.3`, despite 7.0.2 being `latest`.

**Reason.** `typescript-eslint@8.68.0` declares
`peerDependencies.typescript: ">=4.8.4 <6.1.0"`. TypeScript 7 — the native
compiler rewrite — is outside that range, and no typescript-eslint release
supports it yet. Choosing TS 7 means dropping type-aware linting, which
Governance §19 (testing and quality) makes a poor trade for a compile-time
speed gain on a codebase this size.

**Reversal condition.** Adopt TypeScript 7 once typescript-eslint publishes a
release whose peer range admits it.

---

## D-004. `tsc` only — no bundler

**Decision.** The build is `tsc -p tsconfig.build.json`. Output is ESM,
one-file-in/one-file-out, with declarations.

**Reason.** Governance §5 and AI Development Rule §7: the smallest thing that
works. Ferret ships as a Node package, not to a browser, so there is nothing for
a bundler to solve — no tree-shaking benefit that matters at 43 kB, no
transpilation target below Node 22. A bundler would add a dependency, a
configuration surface and a source-map story for no measured gain.

**Reversal condition.** If startup time becomes dominated by module resolution —
measure against the baselines in `docs/Performance/` before assuming it.

---

## D-005. Storage, indexing and MCP are provider *kinds*, not separate stacks

**Decision.** `ProviderKind` covers `storage`, `index`, `source`, `parser`,
`mcp` and `embedding`. There is one provider contract and one registry.

**Reason.** Governance §4 puts *every* replaceable implementation behind a
provider contract. Building four parallel abstraction stacks would be the
speculative abstraction AI Development Rule §7 forbids, and would give later
Epics four contracts to keep consistent instead of one.

**Consequence.** EPIC-086 (storage), EPIC-031 (indexing) and EPIC-064 (MCP)
implement the same contract their source and parser siblings do.

---

## D-006. A runtime instance is single-use

**Decision.** `stopped` and `failed` are terminal. Restarting requires a new
`FerretRuntime`.

**Reason.** The Epic requires startup and shutdown to be *safe and idempotent*,
not that a runtime be restartable. Supporting restart means every subsystem must
correctly re-establish state that shutdown tore down — a recurring source of
half-restored-state bugs — for no requirement. Construction is cheap.

**Consequence.** `initialize()` on a terminal runtime raises
`E_LIFECYCLE_INVALID_STATE` with remediation naming the fix.

---

## D-007. Redaction is applied at serialization, not at the call site

**Decision.** `FerretError.toJSON()`, the logger and `describeConfig()` redact
internally. Callers pass raw values.

**Reason.** Governance §12 makes secret protection Ferret's job, not the
caller's discipline. Redacting at the boundary means a future contributor
cannot leak a credential by forgetting a call — the only way to emit an
unredacted value is to bypass the emitters entirely.

**Consequence.** Redaction runs on every log record and error. Measured cost is
negligible against the ~500 ms process startup; revisit only if a hot path
proves otherwise.

**Note.** This decision found a real defect during implementation: top-level log
fields were value-redacted but not key-redacted, so `logger.info({ password })`
would have leaked. `tests/unit/logging.test.ts` covers it.

---

## D-008. `ferret env` reports facts; it renders no health verdict

**Decision.** `ferret env` reports Node version, platform, cwd, Git presence and
resolved configuration. Dependency check *results* are not exposed there.

**Reason.** EPIC-001 scope includes "environment detection hooks"; EPIC-004 owns
health interpretation via `ferret status` and `ferret doctor`. Reporting
`ok`/`degraded`/`unavailable` from `env` would pre-empt that Epic and create two
places where health is defined.

**Consequence.** The `DependencyCheck` contract exists and is exercised by the
runtime at startup, but has no CLI surface until EPIC-004.

---

## D-009. Git is invoked with `execFile`, never a shell

**Decision.** Subprocess invocation uses `execFile` with an explicit argument
vector and `shell: false`.

**Reason.** EPIC-005 selected the Git executable over an in-process library.
Ferret will index untrusted repository content (Governance §12), and repository
paths will eventually reach subprocess arguments. `execFile` passes the vector
straight to the OS, so no shell metacharacter is ever interpreted. Establishing
this now prevents later Epics inheriting an unsafe primitive.

---

## D-010. No PostgreSQL integration testing in EPIC-001

**Decision.** EPIC-001 adds no database dependency and no Testcontainers setup.

**Reason.** The Epic's non-scope is explicit: "Database schema … [is] not in
scope". EPIC-001 opens no connection, so there is no database behaviour to
integration-test. Adding PostgreSQL solely to have an integration test would be
infrastructure for its own sake, which Governance §14 and §23 reject.

**Consequence.** EPIC-001's integration tests exercise what it *does* own,
against the real artefact rather than mocks: `npm pack`, `npm install -g`, the
installed binary as a spawned process, and real OS signals.

**EPIC-002 introduces real PostgreSQL integration testing** per the EPIC-005
direction, when there is database behaviour to test.

---

## D-011. MIT licence and `LICENSE` file added

**Decision.** The repository carries an MIT `LICENSE`, and `package.json`
declares `"license": "MIT"`.

**Reason.** An npm package requires a licence declaration, and the already-
published `@indoulia/ferret` declares MIT. Recording it makes the existing
position explicit rather than introducing a new one.

**Note.** EPIC-005 §4 flags `buffers@0.1.1` (via `exceljs`) as declaring no
licence. That dependency is **not** present in EPIC-001 — the runtime's three
production dependencies are `commander` (MIT), `pino` (MIT) and `zod` (MIT).
~~The finding remains open against EPIC-027/EPIC-028.~~ **Closed 2026-09-03 by
EPIC-028:** `exceljs` was replaced rather than accepted, so the unlicensed
transitive never entered the tree, and `boundaries.test.ts` fails if it ever
does.
