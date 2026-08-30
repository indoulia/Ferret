# Ferret

Persistent engineering context and knowledge layer for AI-assisted development.

Ferret unifies engineering context, files, history and external project-management
knowledge into an evidence-backed, searchable model that AI clients can query
without repeatedly traversing source systems.

> **Status: foundation complete, model started.** The Foundation & Runtime
> domain is delivered — core runtime and package (EPIC-001), PostgreSQL
> bootstrap and migrations (EPIC-002), the configuration engine (EPIC-003),
> health and diagnostics (EPIC-004), and the technology selection they rest on
> (EPIC-005) — along with the canonical entity model (EPIC-006) and the
> relationship and temporal model (EPIC-007). Indexing, retrieval and the MCP
> server are defined by later Epics and are **not** implemented yet. Commands that belong to those Epics are listed in `--help` as
> `(planned)` and fail with a clear error rather than doing nothing. See
> [What works today](#what-works-today).

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
ferret init --save     # ...and remember the connection, so you need not repeat it
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
| `ferret init` | Implemented | EPIC-002, EPIC-003 |
| `ferret config` | Implemented | EPIC-003 |
| `ferret status` | Implemented | EPIC-004 |
| `ferret doctor` | Implemented | EPIC-004 |
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
| `FERRET_CONFIG` | Use this configuration file instead of the platform default | — |
| `FERRET_CONFIG_HOME` | Use this directory instead of the platform default | — |

### Where configuration comes from

Ferret reads these layers, lowest precedence first (Governance §16):

| Layer | Source | Notes |
| --- | --- | --- |
| Defaults | built in | Ferret starts with no configuration at all |
| Environment discovery | `FERRET_*` variables | |
| User configuration | `ferret config set` | **outranks the environment** — the file is what you chose |
| Repository policy | `.ferret/config.json` | may set **only** `exclude` — see below |
| Session scope | in memory | set by an AI client for one session |
| Explicit operation | CLI flags | nothing stored overrides what you just asked for |

`ferret config list --explain` reports which layer supplied each value.

```bash
ferret config set database.host db.example
ferret config get database.host
ferret config list --explain --json
ferret config path              # where Ferret reads and writes
ferret config audit             # what changed, when, and by whom
```

Changes are validated before they take effect: a rejected change leaves the
stored file byte-identical. Writes are atomic and locked, so concurrent changes
cannot lose one another and a crash cannot leave a torn file.

### Keeping the password out of the file

Instead of storing a secret, store where to find it:

```bash
ferret config set database.password '{"$secret":{"env":"FERRET_PG_PASSWORD"}}'
ferret config set database.password '{"$secret":{"file":"/run/secrets/ferret-db"}}'
```

The reference is what gets written; the secret is read at startup. An
unresolvable reference is an error, never a silently empty password.

### Repository policy is not a configuration channel

A `.ferret/config.json` inside a repository may set **only** `exclude`. It is
committed and shared with everyone who clones that repository, so it must not be
able to repoint your database, change your credentials, enable a provider or
alter your log level. Anything else in the file is ignored and reported by
`ferret config list`. Exclusion is additive and one-way, so the worst a
repository can do is cause less of itself to be indexed.

### Exclusions

Exclusions govern indexing and retrieval. **They never delete evidence Ferret
has already recorded** — a rule carries an `effectiveFrom` instant, so a question
about the past is answered as policy stood then.

```bash
ferret config set exclude '["scratch/**"]'
ferret config exclude list                    # yours plus Ferret's defaults
ferret config exclude test path/to/file.ts    # which rule applies, and why
```

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

## Checking health

```bash
ferret status            # is Ferret working?
ferret doctor            # ...and what do I do about it?
ferret status --json     # the same report, machine-readable
```

Both are **read-only** and neither ever throws: an unreachable database, wrong
credentials and a configuration file that will not parse are all *results*. A
diagnostic that fails when the thing it diagnoses is broken would be useless.

Every component reports one of four states, and the difference matters:

| State | Meaning |
| --- | --- |
| `ok` | Observed working |
| `degraded` | Working with reduced capability — Ferret is still usable |
| `unavailable` | Observed not working |
| `unknown` | **Could not be determined.** Never a synonym for `ok` |

An *optional* component can never make Ferret unusable. An absent pgvector means
semantic retrieval is unavailable, not that Ferret is.

`ferret doctor` lists only findings, each with a stable id a script can branch on
and a remediation you can act on:

```console
ERROR    database/postgres:unavailable
         PostgreSQL rejected the credentials: password authentication failed
      -> Check FERRET_DATABASE_USER and FERRET_DATABASE_PASSWORD against the server.
```

Exit codes identify what to go and fix, so a script need not parse text:

| Code | Condition |
| --- | --- |
| `0` | Healthy, or degraded but usable (`--strict` makes degraded non-zero) |
| `3` | Configuration — no database configured, or the file will not parse |
| `4` | Dependency — the database is unreachable or rejected the credentials |
| `6` | Schema — a migration failed or drifted, or the database is from a newer Ferret |

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
- [Configuration decisions](docs/Architecture/EPIC-003-DECISIONS.md) — precedence,
  the repository trust boundary, secret references and durable writes
- [Diagnostics decisions](docs/Architecture/EPIC-004-DECISIONS.md) — why the
  health model has four states and why a diagnostic may never fail
- [Canonical model decisions](docs/Architecture/EPIC-006-DECISIONS.md) — derived
  identity, why not UUIDv5, and how unknown source fields are kept without
  corrupting the model
- [Relationship decisions](docs/Architecture/EPIC-007-DECISIONS.md) — bitemporal
  intervals, why exclusive relationships need a lock, and how out-of-order
  events are reconciled
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

Schema changes are generated, not hand-written:

```bash
npm run migration:generate -- add_something
```

That diffs `src/storage/schema/` with drizzle-kit and writes the next
`NNNN_name.sql`. **Read the result before committing it** — a schema diff knows
what changed, not what else already exists, and it does not know that dropping a
column loses evidence.

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
