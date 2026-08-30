# Ferret

Persistent engineering context and knowledge layer for AI-assisted development.

Ferret unifies engineering context, files, history and external project-management
knowledge into an evidence-backed, searchable model that AI clients can query
without repeatedly traversing source systems.

> **Status: early foundation.** This release delivers the core runtime and
> package established by EPIC-001. Indexing, retrieval, storage, providers and
> the MCP server are defined by later Epics and are **not** implemented yet.
> Commands that belong to those Epics are listed in `--help` as `(planned)` and
> fail with a clear error rather than doing nothing. See
> [What works today](#what-works-today).

## Requirements

- **Node.js 22 LTS or newer.** Ferret refuses to start on an older runtime.
- **Git on `PATH`** — optional today, required by repository features in later
  Epics. `ferret env` reports whether it was found.

PostgreSQL is Ferret's persistence target, but nothing in this release connects
to a database.

## Install

```bash
npm install -g @indoulia/ferret
ferret --help
```

To use Ferret as a library:

```bash
npm install @indoulia/ferret
```

```ts
import { createRuntime } from '@indoulia/ferret';

const version = await createRuntime().run((context) => context.version);
console.log(version);
```

`run()` initializes the runtime, executes the body and shuts down again — even
if the body throws — so a started runtime cannot leak.

## What works today

| Command | Status | Owner |
| --- | --- | --- |
| `ferret --help` / `-h` | Implemented | EPIC-001 |
| `ferret --version` / `-v` | Implemented | EPIC-001 |
| `ferret version` | Implemented | EPIC-001 |
| `ferret env` | Implemented | EPIC-001 |
| `ferret init` | Planned | EPIC-002, EPIC-003 |
| `ferret config` | Planned | EPIC-003 |
| `ferret status` | Planned | EPIC-004 |
| `ferret doctor` | Planned | EPIC-004 |
| `ferret mcp` | Planned | EPIC-064 |

A planned command exits with code `5` and error code `E_NOT_IMPLEMENTED`, naming
the Epic that will deliver it.

## Global options

| Option | Effect |
| --- | --- |
| `--json` | Emit one JSON document on stdout instead of human text |
| `--log-level <level>` | `silent`, `fatal`, `error`, `warn` (default), `info`, `debug`, `trace` |

### Output discipline

- **stdout** carries the command result and nothing else. Under `--json` it is
  exactly one JSON document, so it can be piped straight into a parser.
- **stderr** carries human diagnostics and the structured NDJSON log stream.

That separation is what lets an AI client consume Ferret without parsing
decorated terminal text.

```bash
ferret env --json | jq .data.node
ferret env --log-level debug 2> ferret.log
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Unclassified failure |
| `2` | Usage error — unknown command, bad option or bad argument |
| `3` | Configuration missing or invalid |
| `4` | A required dependency is unavailable or unsupported |
| `5` | The command is planned but not implemented in this release |
| `130` | Interrupted (`SIGINT`) |
| `143` | Terminated (`SIGTERM`) |

## Configuration

A normal Ferret setup requires only database details and optional exclusions.
Nothing needs to be configured to start Ferret — every value below has a safe
default or is genuinely optional.

| Variable | Purpose | Default |
| --- | --- | --- |
| `FERRET_DATABASE_HOST` | PostgreSQL host | — |
| `FERRET_DATABASE_PORT` | PostgreSQL port | `5432` |
| `FERRET_DATABASE_NAME` | Database name | — |
| `FERRET_DATABASE_USER` | Database user | — |
| `FERRET_DATABASE_PASSWORD` | Database password | — |
| `FERRET_EXCLUDE` | Comma/semicolon-separated paths excluded from indexing | empty |
| `FERRET_LOG_LEVEL` | Structured log verbosity | `warn` |

Environment variables are the only configuration source in this release. Files,
repository policy and session scope arrive with EPIC-003, which adds them behind
the same `ConfigSource` interface without changing the runtime.

Secrets are redacted everywhere Ferret renders configuration — `ferret env`,
error details and log records alike:

```console
$ FERRET_DATABASE_PASSWORD=hunter2 ferret env --json | jq .data.config.database
{
  "host": "db.internal",
  "port": 5432,
  "database": "ferretdb",
  "user": "ferret",
  "password": "[redacted]"
}
```

## Documentation

- [Runtime architecture](docs/Architecture/RUNTIME.md) — lifecycle, boundaries,
  error model and the contracts later Epics extend
- [Governance](docs/Governance/README.md) — the binding engineering rules
- [Technology decisions](docs/TECHNOLOGY-DECISIONS.md) — the EPIC-005 stack
  selection and its evidence
- [Epic registry](docs/EPICs/README.md) — the delivery map

## Development

```bash
npm install
npm run verify     # lint, typecheck, build, test
npm run build
npm test
npm run baseline   # record startup and package-size baselines
```

## Licence

MIT — see [LICENSE](LICENSE).
