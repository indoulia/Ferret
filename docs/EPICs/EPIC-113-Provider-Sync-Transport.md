# EPIC-113 — Provider Sync Transport (`ferret sync`)

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** CONTINUATION

## Outcome

`ferret sync` reads a configured tracker, models what it read into canonical
knowledge, stores it, and remembers where it got to — in one explicit pass.

## Problem

The GitHub provider (EPIC-021), the Jira provider (EPIC-071), the project model
(EPIC-072) and the sync cursor store (EPIC-075) all existed, were tested, and
were reachable as libraries. **Nothing called them in order.** `ferret sync` was
the last `(planned)` entry in the command surface, and `planned.ts` said exactly
why: *"the GitHub and Jira providers exist and are tested as libraries; nothing
wires them to a transport or persists what they return."*

A second, smaller defect surfaced while composing it. Both providers declared
`configSchema` and `secretOptions` from the day they were written, so
`providers['ferret.source.github'].options.token` validated, redacted, and
reached `context.settings` — and **nothing read it**. Every option had to be
passed to `createGithubProvider`, which no composition outside a test does.
EPIC-113 is the first caller that builds a provider from configuration, which is
what surfaced it.

## Decisions this Epic implements

Three product decisions, taken by the owner on 2026-09-05 against the
[decision queue](ROADMAP.md#epic-113--provider-sync-transport-ferret-sync).

**D-113.1 — credentials may be persisted encrypted at rest.** *Authorised, and
not used.* With D-113.2 fixing sync as a one-shot command, there is nothing for
a stored credential to outlive: the token is resolved from configuration on
every invocation through the `$secret` mechanism EPIC-081 and EPIC-015 already
built. The decision also forbade inventing an encryption or key-management
mechanism, and Ferret has none — `config/at-rest.ts` reports file permissions,
not encryption. So nothing is stored, EPIC-081's posture is unchanged, and the
authorisation stays available for whatever first needs it.

**D-113.2 — explicit command, no daemon.** One request in, one report out.
Ferret runs no timer; the scheduler is `cron`, a `systemd` timer or Task
Scheduler, exactly as `ferret reconcile` already says. Scheduling is documented
as a future extension and is **not** implemented.

**D-113.3 — a remote edit supersedes through the model that already exists.**
An issue whose state changed is a new observation of the same subject and field.
`EvidenceStore.record` closes the prior current reading and points it at the new
one (EPIC-047 §8.2), so the old statement stays on record and stays verifiable.
Nothing new was invented, and the decision instructed exactly that. A record the
tracker did not return is not touched at all.

## Design

**`ProjectSynchronizer` is core logic and takes ports.** `src/project/sync.ts`
knows nothing about PostgreSQL: it takes `EntityWriter`, `RelationshipWriter`,
`EvidenceWriter` and `SyncCursors` from `indexing/ports.ts`, which the EPIC-002
stores satisfy structurally. The same separation `RepositoryIndexer` has, for the
same reason.

**Entities, then relationships, then evidence.** Not a preference: the database
has foreign keys, and the reverse order fails on a project never synchronized
before. Gap-filling endpoints are written `ifAbsent` (issue #48).

**The repository entity is written.** `modelProject` takes `repositoryId` as an
input and scopes every record to it without emitting it, so before this the id a
pass reported named no row. The synchronizer writes it as a placeholder — a
dangling scope is EPIC-072 §8.10's defect one level up.

**The cursor advances only on a completed pass.** EPIC-031's rule, which
EPIC-075 gave a separate verb for precisely so it could be applied here. A
truncated enumeration, a dry run, and a pass with no cursor store all leave the
position where it was, so the next pass re-reads rather than skipping what it
never saw. The next `since` is the instant the pass *started*, not the newest
record seen: a record edited mid-pass would otherwise fall outside the next
window. The overlap is free — EPIC-080 makes the writes idempotent.

**Bounded, because the budget is not Ferret's.** `--page-limit` (default 20
pages per collection) and `--review-limit` (default 50 pull requests). The two
bounds are reported **separately**, and the distinction is load-bearing rather
than tidy:

- A page limit means the *enumeration stopped*. There are records this pass
  never saw, so advancing the cursor would skip them. It reports `truncated` and
  the cursor stays where it was.
- A review ceiling means the enumeration *finished* and some pull requests'
  reviews were not fetched. Re-reading the same window would fetch the same
  first fifty again and make no progress, so it reports `reviewsPartial` and the
  cursor advances; the next pass asks only for what changed, and a pull request
  whose reviews are wanted is read again when it changes.

Conflating them was a defect, found by running the command against Ferret's own
repository: 139 pull requests, the ceiling bit, and the cursor could never
advance — so every pass would have re-read the whole tracker for ever, which is
precisely the incremental behaviour the cursor exists to provide.

**Unsupported and unchanged are different from empty.** An operation the
provider did not declare is named in `unsupported` and never called — Jira has
no pull requests, and an empty page would make that indistinguishable from "this
project has none". A conditional `304` is reported as `unchanged`, and its etag
survives into the cursor.

**Composition is decided by configuration.** A provider absent from `providers`
is not constructed at all. Governance §2: nothing is mandatory to start Ferret,
and a GitHub provider nobody configured has nothing to say.

## Scope

- `src/project/sync.ts` — `ProjectSynchronizer`.
- `src/cli/commands/sync.ts` — `ferret sync [projects...]`.
- `toEntityInput` / `toRelationshipInput` / `toEvidenceInput` shared from
  `src/indexing/ports.ts`; the indexer's private copies removed.
- `projects` option on the GitHub and Jira schemas; both providers now read
  `context.settings`.
- `PLANNED_COMMANDS` emptied.

## Non-scope

- **A daemon or scheduler.** D-113.2.
- **Persisting a credential.** D-113.1; authorised, not needed, not built.
- **Releases and deployments.** `modelReleases` needs a commit-ancestry walk and
  therefore a Git source alongside the tracker. The planned entry promised
  "issues, pull requests and reviews", which is what this delivers; EPIC-073's
  modelling stays reachable as a library.
- **Comments.** `listComments` is declared by both providers and modelled by
  neither. Ingesting a record the canonical model has no kind for would be
  inventing an entity model to fill a transport.
- **Resolving a body reference to a tracker record.** "Fixes #1" produces its own
  placeholder issue; reconciling it with `I_kwDO1` is EPIC-051's.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A pass reads, models and writes, entities before relationships before evidence | `project-sync.test.ts` (unit) — "stores entities before relationships before evidence" |
| 2 | The cursor advances to the pass start instant and is read back next pass | unit "advances to the instant the pass started"; integration "advances a cursor a later pass reads back" |
| 3 | A truncated enumeration does not advance the cursor | unit "does not advance when a page limit stopped the enumeration short" |
| 3a | A review ceiling is reported and does **not** block the cursor | unit "bounds reviews, says so, and still advances the cursor"; "reports reviews as complete when the ceiling did not bite"; "honours a caller-supplied review limit" |
| 4 | An undeclared operation is named, never called | unit "never calls an operation the provider did not declare" |
| 5 | A dry run writes nothing and advances nothing | unit "models the records and stores none of them" |
| 6 | One malformed record is skipped, not fatal | unit "skips it, names it, and stores the rest" |
| 7 | Every project is scoped to one derived repository entity | unit "derives the same id a foreign reference would" |
| 8 | The graph survives PostgreSQL's constraints | integration "stores the whole graph a pass produced" |
| 9 | The same input twice writes one row | integration "writes one row for the same input twice" |
| 10 | A remote edit supersedes without losing what it replaced | integration "supersedes a remote edit without losing what it replaced" |
| 11 | The command is served, not planned | `sync-cli.test.ts` — "is advertised without the planned marker"; "no longer exits 5" |
| 12 | An unconfigured Ferret refuses with a remediation | `sync-cli.test.ts` — "refuses with a remediation naming what to configure" |
| 13 | A configured tracker is read through a `$secret` token and stored | `sync-cli.test.ts` — "synchronizes the configured project with no argument at all" |
| 14 | The second pass asks only for what changed | `sync-cli.test.ts` — "advances a cursor, so the second pass asks only for what changed" |
| 15 | A dry run through the binary writes nothing | `sync-cli.test.ts` — "reads and writes nothing on a dry run" |
| 16 | The pass is authorized as an ingestion | `cli-authorization.test.ts` — refusal and control pair |
| 17 | No credential reaches a stored row | `sync-cli.test.ts` — "never writes the token anywhere it could be read back" |

## Tests

14 unit cases (`tests/unit/project-sync.test.ts`), 5 storage integration cases
(`tests/integration/storage/project-sync.test.ts`), 8 CLI cases against the built
binary and a local HTTP server standing in for the GitHub API
(`tests/integration/storage/sync-cli.test.ts`), and 2 authorization cases.

## Dependencies

EPIC-021, EPIC-071, EPIC-072, EPIC-075, EPIC-080, EPIC-015, EPIC-081, EPIC-002.

## Known limitations

- **Reviews cost one request per pull request.** GitHub has no bulk endpoint.
  Bounded at 50 per pass by default, reported as `reviewsPartial` beyond that,
  and raisable with `--review-limit`. A pull request beyond the ceiling has its
  reviews read on a later pass, when it next changes — so a repository whose
  first sync exceeds the ceiling converges rather than staying incomplete.
- **Only GitHub and Jira are composed.** `composeProjectSources` names them
  explicitly rather than discovering every `source.project` provider, because a
  third-party provider's required construction options are not knowable from the
  core. EPIC-074's `providerModules` path does not reach this command.
- **A tracker's deletions are not observed.** An issue deleted upstream stays
  in Ferret. EPIC-032's rule holds — deletion is observed, never inferred — and
  no tracker endpoint reports one.

## Definition of done

All acceptance criteria implemented and tested, the `(planned)` entry retired,
typecheck/lint/build clean, and merged through normal governance.
