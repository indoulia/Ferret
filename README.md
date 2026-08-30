# Ferret

Persistent engineering context and knowledge layer for AI-assisted development.

Ferret unifies engineering context, files, history and external project-management
knowledge into an evidence-backed, searchable model that AI clients can query
without repeatedly traversing source systems.

> **Status: early foundation.** This release delivers the core runtime and
> package (EPIC-001) and PostgreSQL bootstrap and migrations (EPIC-002).
> Indexing, retrieval, the canonical model and the MCP server are defined by
> later Epics and are **not** implemented yet. Commands that belong to those
> Epics are listed in `--help` as `(planned)` and fail with a clear error rather
> than doing nothing. See [What works today](#what-works-today).

## Requirements

- **Node.js 22 LTS or newer.** Ferret refuses to start on an older runtime.
- **Git on `PATH`** — optional today, required by repository features in later
  Epics. `ferret env` reports whether it was found.
- **PostgreSQL 14 or newer** — required by `ferret init` and everything that
  stores knowledge. Not needed for `ferret --version`, `ferret --help` or
  `ferret env`, which work with no database at all.
- **pgvector** — optional. Semantic retrieval (EPIC-054) needs it; deterministic
  retrieval does not. `ferret init` enables it when the server offers it and the
  role may create it, and reports honestly when it cannot.

## Install

```bash
npm install -g @indoulia/ferret
ferret --help
```

### Set up the database

```bash
export FERRET_DATABASE_HOST=localhost
export FERRET_DATABASE_NAME=ferret
export FERRET_DATABASE_USER=ferret
export FERRET_DATABASE_PASSWORD=...

ferret init            # create the schema and apply pending migrations
ferret init --check    # report what would change, without touching anything
```

`ferret init` is idempotent: run it as often as you like. It applies only what
is pending, so it doubles as a cheap way to confirm the database is current.

Ferret does not need superuser. A role that can `CREATE` in the database is
enough; if it also may `CREATE EXTENSION`, pgvector is enabled automatically.

### Use Ferret as a library

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
| `ferret init` | Implemented (database half) | EPIC-002 |
| `ferret init --check` | Implemented | EPIC-002 |
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
| `6` | The database is reachable but its schema is unusable — a migration failed, is pending under a policy that forbids applying it, was applied by a newer Ferret, or was edited after being applied |
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
| `FERRET_DATABASE_MIGRATE` | `auto` applies pending migrations on start, `verify` refuses to start behind, `off` neither migrates nor complains. `ferret init` always applies. | `auto` |
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
  "password": "[redacted]",
  "migrate": "auto"
}
```

## Schema and recovery

Migrations are versioned SQL, checksummed, and applied under a PostgreSQL
advisory lock, so several Ferret processes starting at once cannot corrupt the
schema — each migration is applied exactly once. A migration and the record that
it ran commit in a single transaction, so a crashed process leaves the database
at its last good version and never in between.

When a migration does fail, the reason is recorded in
`ferret.schema_migration_failures` rather than only in a log, and it is cleared
when a later attempt succeeds. `ferret init --check --json` reports the applied
version, the target version, anything pending and any recorded failure.

Recovery is fix-and-roll-forward: Ferret has no `down` migrations. An applied
migration must never be edited — its checksum is verified on every start, and a
mismatch is refused as `E_SCHEMA_DRIFT` rather than silently re-applied.

## Documentation

- [Runtime architecture](docs/Architecture/RUNTIME.md) — lifecycle, boundaries,
  error model and the contracts later Epics extend
- [Storage decisions](docs/Architecture/EPIC-002-DECISIONS.md) — migration
  atomicity, locking, failure recovery and why each was chosen
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

Database integration tests need PostgreSQL. They use `FERRET_TEST_DATABASE_URL`
when it is set, otherwise start a `pgvector/pgvector:pg17` container through
Docker. With neither available they **skip loudly**, naming the reason in the
test title — they never silently pass.

`FERRET_TEST_DATABASE_URL` is a standard PostgreSQL connection URL of the shape
`postgres://<user>@<host>:<port>/<database>`, with the password in the userinfo
section. It carries a credential, so keep it in your shell — never in a file.

```bash
export FERRET_TEST_DATABASE_URL="$MY_LOCAL_PG_URL"
npm test

FERRET_SKIP_DOCKER_POSTGRES=1 npm test    # skip them deliberately
```

The suite creates and drops a throwaway database per test, so it needs a role
that may `CREATE DATABASE`. It never writes to the database named in the URL.

## Licence

MIT — see [LICENSE](LICENSE).
