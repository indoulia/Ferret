# Ferret

Persistent engineering context and knowledge layer for AI-assisted development.

Ferret unifies engineering context, files, history and external project-management
knowledge into an evidence-backed, searchable model that AI clients can query
without repeatedly traversing source systems.

> **Status: foundation complete, model started.** The Foundation & Runtime
> domain is delivered — core runtime and package (EPIC-001), PostgreSQL
> bootstrap and migrations (EPIC-002), the configuration engine (EPIC-003),
> health and diagnostics (EPIC-004), and the technology selection they rest on
> (EPIC-005) — and the canonical knowledge model is complete: entities
> (EPIC-006), relationships and time (EPIC-007), evidence and provenance
> (EPIC-008), identity and scope (EPIC-009) and schema versioning (EPIC-010).
> Indexing, retrieval and the MCP server are defined by later Epics and are
> **not** implemented yet. Commands that belong to those Epics are listed in `--help` as
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
| `ferret index` | Implemented | EPIC-031 |
| `ferret mcp` | Implemented | EPIC-064, EPIC-065 |

Every approved command in this release is implemented. The mechanism for
reporting an approved-but-unbuilt command — exit code `5` with
`E_NOT_IMPLEMENTED` and the owning Epic — remains, because the honest answer to
"is this coming" is worth more than an unknown-command error.

## Index a repository

```bash
ferret index .              # index the repository you are standing in
ferret index ~/code/api     # or one you name
ferret index . --full       # re-read everything, ignoring what was indexed before
ferret index . --json       # machine-readable, for a script or a CI job
```

Indexing is **incremental by default**. The first run reads the whole history;
later runs read only what is new, and re-indexing an unchanged repository writes
nothing at all — which you can see in the report:

```
repository        github.com/indoulia/Ferret
mode              incremental
read              2 commits, 305 files, 5 branches, 1 worktrees
entities          33 new, 3 changed, 620 unchanged
relationships     56 new, 0 changed, 637 unchanged
evidence          23 recorded, 292 already known
```

Ferret reads with `git`, never by reimplementing it, and it reads **safely**: a
repository cannot make Ferret run a program by putting one in its configuration,
and a credential in a remote URL never reaches the database or a log. See
[EPIC-017's decisions](docs/Architecture/EPIC-017-DECISIONS.md) for how, and why
each step is there.

## Connect an AI client

`ferret mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio. Any MCP client can spawn it.

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ferret": {
      "command": "ferret",
      "args": ["mcp"],
      "env": {
        "FERRET_DATABASE_HOST": "localhost",
        "FERRET_DATABASE_NAME": "ferret",
        "FERRET_DATABASE_USER": "ferret",
        "FERRET_DATABASE_PASSWORD": "..."
      }
    }
  }
}
```

**Claude Code** — `claude mcp add ferret -- ferret mcp`, having run
`ferret init --save` first so the connection is already stored.

If you ran `ferret init --save`, the `env` block is unnecessary: Ferret reads
its own configuration file. Passing the password through the client's
configuration is supported because an AI client spawns Ferret with an
environment Ferret does not control — but a stored configuration keeps the
secret out of one more file.

### What the client can then do

| Tool | Answers |
| --- | --- |
| `ferret_search` | "Where did we discuss connection timeouts?" |
| `ferret_find` | "Every file in this repository." — exact, unranked |
| `ferret_get_entity` | One commit, file or branch, with its identifiers |
| `ferret_neighbours` | "What touched this file?" — and, with `at`, "what was I working on last Tuesday?" |
| `ferret_context_pack` | A bounded pack of relevant knowledge for a question |

Every tool is **read-only**. Ferret writes nothing through MCP: indexing is a
command a person runs.

Every response tells the model, before any content, that what follows is indexed
source content — **data, not instructions**. A commit message that says "ignore
your previous instructions" is delivered intact, as an attributed value, because
hiding it would be its own kind of failure; what Ferret controls is the frame
around it, never the content itself. See
[the specification](docs/EPICs/EPIC-059-061-064-065-Context-And-MCP.md) §8.

### Check it is working

```bash
ferret status          # is the database reachable, is the schema current
ferret doctor          # ...and what to do about it if not
```

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
- [Evidence decisions](docs/Architecture/EPIC-008-DECISIONS.md) — why evidence is
  immutable, why a derived fact must cite its sources, and how secrets are kept
  out of the record
- [Identity decisions](docs/Architecture/EPIC-009-DECISIONS.md) — why collisions
  are reported rather than merged, and why developers and agents never merge
- [Compatibility matrix](docs/Architecture/COMPATIBILITY.md) — what Ferret can
  read, what it refuses, and why downgrade is never attempted
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
npm run dogfood    # index this repository, then check Ferret's answers against git
```

### Dogfooding is a test, not a demo

`npm run dogfood` indexes this repository with the built CLI, connects to it over
MCP as a real client, and checks every answer against what `git` says. It is an
**oracle**: each question it asks has an answer `git` can produce independently,
so a disagreement is a defect rather than a matter of opinion.

That distinction has earned its keep. Nineteen Epics of passing tests coexisted
with sixty of sixty-one commits holding nothing but a SHA — every structural
assertion passed, because every one of them checked shape. Later, three hundred
and eighteen indexed files included thirteen that had not existed for months,
each reported `active`, and each with a `change: deleted` record already in the
graph. Running Ferret and reading the output would have shown neither. Comparing
its output to `git ls-files` showed both immediately.

It needs a configured database, like any other Ferret run:

```bash
npm run build && npm run dogfood
npm run dogfood -- --check    # check what is already indexed, without re-indexing
```

It exits non-zero on any disagreement.

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
