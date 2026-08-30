# Ferret Runtime Architecture

**Status: CURRENT**
**Version: 1.0**
**Effective: 2026-08-30**
**Established by: EPIC-001 — Core Runtime & Package**

This document describes the runtime foundation delivered by EPIC-001: what
exists, what is deliberately absent, and which contracts later Epics extend.

It documents implementation, not policy. `docs/Governance/README.md` remains
authoritative; where this document interprets a rule, the rule wins.

---

## 1. Layering

```text
             ┌─────────────────────────────────────────┐
   bin       │  dist/cli/main.js  (bin: ferret)        │
             └───────────────────┬─────────────────────┘
                                 │
             ┌───────────────────▼─────────────────────┐
   cli/      │  program · commands · output · exit codes│  commander
             └───────────────────┬─────────────────────┘
                                 │  depends downward only
             ┌───────────────────▼─────────────────────┐
   runtime/  │  FerretRuntime · lifecycle · disposables │
             │  signals                                 │
             └──┬──────────┬──────────┬──────────┬─────┘
                │          │          │          │
     config/  ──┘  diagnostics/  providers/  environment/
                │          │          │          │
             ┌──▼──────────▼──────────▼──────────▼─────┐
   errors/   │  FerretError · codes · redaction         │
   logging/  │  structured logger                       │  pino, zod
             └─────────────────────────────────────────┘
```

Dependencies point downward only. Two rules make that enforceable rather than
aspirational, and `tests/unit/boundaries.test.ts` checks both by walking the
static import graph:

1. **`src/index.ts` never reaches `src/cli/**`.** The CLI is one consumer of the
   runtime; the MCP server (EPIC-064) will be another.
2. **`src/index.ts` imports only `node:*`, `pino` and `zod`.** Adding to that
   list is a deliberate architectural decision — it widens what every consumer
   of `@indoulia/ferret` installs — and the test fails until the list is
   updated on purpose.

`commander` is a CLI-layer dependency and is asserted absent from the core
graph.

---

## 2. Lifecycle

```text
created ──initialize()──▶ initializing ──▶ ready ──shutdown()──▶ stopping ──▶ stopped
                               │                                     │
                               └──────────── failed ◀────────────────┘
```

`initialize()` performs, in order:

1. resolve configuration from the registered `ConfigSource`s;
2. construct the logger at the resolved level;
3. detect the environment (Node version, platform, Git);
4. run dependency checks, and fail if a **required** one is unhealthy;
5. initialize registered providers in registration order;
6. collect provider dependency results;
7. publish the `RuntimeContext` and enter `ready`.

### Idempotency and concurrency

- `initialize()` on a ready runtime is a no-op. Concurrent calls join the
  in-flight initialization rather than starting a second one.
- `shutdown()` is safe from every state, including one where initialization
  never ran. Concurrent calls join the in-flight shutdown.
- `stopped` and `failed` are **terminal**. A runtime instance runs once;
  restarting requires a new instance. Instances are cheap, and forbidding
  restart removes a class of half-restored state bugs.

### Failure and cleanup

A failed start releases everything it opened before the error propagates:
initialized providers are shut down in reverse order, disposables are drained,
and the runtime's `AbortSignal` is aborted. There is no state in which
initialization failed and a resource is still held.

`shutdown()` attempts **every** provider and disposable even when one throws, so
a single wedged handle cannot strand the rest. Failures are aggregated into one
`E_SHUTDOWN_FAILED` after all cleanup has been attempted.

### `run()`

```ts
await runtime.run(async (context) => { /* ... */ });
```

Initializes, runs the body, and shuts down in a `finally` — even when the body
throws. This is the supported way to use the runtime for a single operation,
because it makes leaking a started runtime impossible.

### Signals

`installSignalHandlers()` routes `SIGINT` (exit 130) and `SIGTERM` (exit 143)
into a graceful shutdown. A second signal exits immediately; a grace timer,
unref'd so it never itself holds the process open, bounds the wait.

It takes a `shutdown` callback rather than a runtime, so a caller that owns
several runtimes — or has not constructed one yet — can still wire signals up.

**Node.js does not deliver `SIGTERM` on Windows**, and `SIGINT` only arrives
through console emulation a spawned child does not receive. Registration
failures are ignored rather than fatal, so behaviour degrades to `SIGINT`-only.
See [Known limitations](#8-known-limitations).

---

## 3. Configuration boundary

EPIC-001 establishes the boundary; **EPIC-003 owns the engine**.

Configuration is assembled from ordered `ConfigSource` layers:

```ts
interface ConfigSource {
  readonly name: string;
  readonly precedence: number;
  read(): Record<string, unknown>;
}
```

The precedence ladder mirrors Governance §16. EPIC-001 populates the first two
rungs; the remainder are reserved so later Epics slot in without renumbering:

| Rung | Value | Delivered by |
| --- | ---: | --- |
| `DEFAULTS` | 0 | EPIC-001 (schema defaults) |
| `ENVIRONMENT` | 100 | EPIC-001 |
| `USER` | 200 | EPIC-003 |
| `REPOSITORY` | 300 | EPIC-003 |
| `SESSION` | 400 | EPIC-003 |
| `EXPLICIT` | 500 | EPIC-003 |

Two invariants hold from here on:

- **Resolution succeeds with no configuration at all.** Nothing must be authored
  to start Ferret (Governance §2). `resolveConfig([])` yields a valid config.
- **The mandatory surface is database details plus optional exclusions**, and
  nothing else may become mandatory.

Every field is optional at this layer because EPIC-001 opens no connection.
Completeness is enforced by the subsystem that needs it —
`isDatabaseConfigured()` and `missingDatabaseFields()` exist for EPIC-002 to use.

---

## 4. Provider boundary

Governance §4 puts *every* replaceable implementation behind a provider
contract. Ferret therefore has **one** provider system rather than parallel
abstraction stacks for storage, indexing and MCP; those are provider *kinds*:

| Kind | Owning Epic |
| --- | --- |
| `storage` | EPIC-086 PostgreSQL Storage Layer |
| `index` | EPIC-031 Incremental Indexing |
| `source` | EPIC-017 Local Repositories, EPIC-021 GitHub, EPIC-071 Jira |
| `parser` | EPIC-024 Parser Framework |
| `mcp` | EPIC-064 MCP Server |
| `embedding` | EPIC-054 Semantic Retrieval |

A provider declares the `PROVIDER_CONTRACT_VERSION` it was built against; the
registry refuses anything it cannot honour, so a stale provider fails loudly at
registration rather than subtly at runtime.

Providers receive capabilities through `ProviderContext` — logger, config,
environment, abort signal — and never reach for `process.env` or build their own
logger. That keeps a provider testable and keeps its configuration subject to
Ferret's precedence rules.

Lifecycle: initialize in registration order, shut down in reverse. Registration
is sealed once initialization starts.

**Automatic discovery is EPIC-013.** The registry accepts explicit registration
today and is shaped to take a discovery source without a contract change.

---

## 5. Diagnostics boundary

`DependencyCheck` is the shared health vocabulary. EPIC-001 uses it to gate
startup; **EPIC-004 builds `ferret status` and `ferret doctor` on it.**

| Status | Meaning |
| --- | --- |
| `ok` | Healthy |
| `degraded` | Usable, with reduced capability |
| `unavailable` | Not usable |
| `unknown` | The check could not run |

`unknown` exists because Governance §6 forbids manufacturing certainty. A check
that throws is recorded as `unknown` — never as `ok`.

Core checks:

| Check | Required | Absent behaviour |
| --- | --- | --- |
| `node-version` | yes | Startup fails with `E_DEPENDENCY_UNAVAILABLE` |
| `git` | no | `degraded`; repository features (EPIC-017) unavailable |

`ferret env` deliberately reports **facts only** — Node version, platform, cwd,
Git presence, resolved configuration. It renders no health verdict; that
interpretation belongs to EPIC-004.

---

## 6. Error model

`FerretError` is the single structured error crossing the public boundary:

```ts
{ code, message, retryable, details?, remediation?, cause? }
```

- **Codes are a public contract.** AI clients and scripts branch on them, so a
  code's meaning never changes once published. Codes are added, never
  repurposed.
- **Redaction happens at serialization, not at the call site.** `toJSON()` runs
  every field through `redact()`, and the constructor redacts the message. A
  caller therefore cannot leak a credential by forgetting to redact.
- **Nothing is swallowed.** `serializeError()` turns any thrown value —
  including a non-`Error` — into a redacted structured error classified as
  `E_UNKNOWN`. An error is never converted into success.
- **Rejected configuration values are never echoed**, because a rejected value
  may itself be a credential. Validation reports the path and the rule only.

### Redaction

Conservative by design: over-redaction is cosmetic, under-redaction is a
security defect. Three mechanisms compose:

1. **Key names** — `password`, `token`, `apiKey`, `authorization`, … matched
   against the tokenized key, so `apiKey`, `api_key` and `API-KEY` all match.
2. **Value shapes** — PEM private-key blocks, GitHub tokens, AWS key ids, JWTs
   and `sk-` prefixed keys are masked regardless of the key they sit under.
3. **Embedded credentials** — URI userinfo and `password=` entries in connection
   strings are masked while the diagnosable parts (scheme, host, database) are
   preserved.

Cycles become `[circular]`, depth is capped, and non-plain objects are reduced
to a type marker rather than walked, so class internals never leak.

### Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | Unclassified failure |
| 2 | Usage error |
| 3 | Configuration missing or invalid |
| 4 | Required dependency unavailable or unsupported |
| 5 | Command is planned but not implemented |
| 130 | Interrupted (`SIGINT`) |
| 143 | Terminated (`SIGTERM`) |

Every `ErrorCode` maps to exactly one exit code, and a test asserts the mapping
is total.

---

## 7. CLI and output discipline

- **stdout** carries the command result and nothing else. Under `--json` it is
  exactly one JSON document.
- **stderr** carries human diagnostics and the structured NDJSON log stream.

That separation is what lets an AI client consume Ferret without parsing
decorated terminal text. The default log level is `warn`, so ordinary runs are
silent on stderr.

### Planned commands

Commands owned by later Epics appear in `--help` marked `(planned — EPIC-0NN)`
and fail with `E_NOT_IMPLEMENTED` and exit code 5, naming the owning Epic. The
command *structure* is EPIC-001's; the *behaviour* is the named Epic's. Nothing
is silently ignored and nothing is falsely advertised as working.

### Testability

`run()` returns an exit code rather than calling `process.exit`, and Commander's
`exitOverride` is applied to the whole command tree — `addCommand` does not
propagate it, so a subcommand usage error would otherwise bypass the exit-code
contract entirely. Signal handling and last-resort fault handlers live only in
the process entry point, so importing the module has no side effects.

---

## 8. Known limitations

| Limitation | Consequence | Carried to |
| --- | --- | --- |
| macOS not validated | No macOS support claim is made | EPIC-105 |
| `SIGTERM` undeliverable on Windows | Signal tests skip there; graceful stop is `SIGINT`-only | EPIC-105 |
| No database connection | `isDatabaseConfigured()` is advisory only | EPIC-002 |
| No provider discovery | Providers must be registered explicitly | EPIC-013 |
| Environment is the only config source | No file or repository policy yet | EPIC-003 |

---

## 9. Implementation decisions

Decisions taken during EPIC-001 that later Epics inherit are recorded in
[`EPIC-001-DECISIONS.md`](EPIC-001-DECISIONS.md).
