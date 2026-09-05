# EPIC-113 — Provider sync transport: validation evidence

**Status: VALIDATED** · the last `(planned)` command is served. No schema change
and no migration: the cursor is a `derived_artifact` row EPIC-075 already
defined.

## Environment

| | |
| --- | --- |
| Tree | `ae77c10` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | Real PostgreSQL 17 + pgvector, local container |
| Tracker | Local HTTP server on `127.0.0.1`, reached through the provider's own `baseUrl` option |
| Date | 2026-09-05 |

## What the Epic does

`ferret sync [projects...]` composes the GitHub or Jira provider, the EPIC-072
project model, the three canonical stores and the EPIC-075 cursor store into one
explicit pass. Records in, entities/relationships/evidence out, cursor advanced,
report returned.

The three owner decisions are implemented as
[EPIC-113's spec](../EPIC-113-Provider-Sync-Transport.md) records them. The one
worth restating here is **D-113.1**: persisting a credential was authorised and
is not done. With sync fixed as a one-shot command there is nothing for a stored
credential to outlive, and the decision forbade inventing key management to
satisfy it. `sync-cli.test.ts` proves the token travels from a `$secret`
reference to the request and reaches no stored row.

## A defect found while composing it

Both providers declared `configSchema` and `secretOptions` from the day they were
written, and **neither read `context.settings`**. Configuring
`providers['ferret.source.github'].options.token` validated, redacted, appeared
in `ferret config show` as `[redacted]` — and did nothing, because every option
had to be passed to the constructor. No composition outside a test did that, so
the whole of EPIC-015's per-provider configuration was unreachable for the two
providers that declared secrets.

It is recorded rather than quietly fixed for the same reason EPIC-112's redaction
gap was: the shape is instructive. A seam that only tests exercise is a seam
nobody has used, and declaring a schema is not the same as reading one.

## Acceptance criteria

Measured runs: `project-sync.test.ts` (unit) — **14 passed, 65 ms**;
`project-sync.test.ts` (integration) — **5 passed, 1 122 ms**;
`sync-cli.test.ts` — **8 passed, 11 515 ms**; `cli-authorization.test.ts` —
**14 passed, 22 871 ms** (2 of them this Epic's); `tests/unit` — **2 218 passed,
91 files**; `tests/integration/indexing`, `tests/integration/providers`,
`tests/security`, `project-modeling.test.ts`, `idempotence.test.ts` — **293
passed, 22 files**.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 reads, models, writes in dependency order | PASS | "stores entities before relationships before evidence" — asserted as a partition of the write sequence, so the foreign-key order cannot regress |
| AC-2 the cursor advances and is read back | PASS | unit "advances to the instant the pass started, and asks from it next time"; integration "advances a cursor a later pass reads back" — read through a *second* `SyncCursorStore`, from the row |
| AC-3 a truncated pass does not advance | PASS | "does not advance when a page limit stopped the enumeration short"; the review ceiling case asserts the same |
| AC-4 an undeclared operation is named, never called | PASS | "never calls an operation the provider did not declare" — the Jira shape: `unsupported: ['pullRequests']` and one call made |
| AC-5 a dry run writes nothing | PASS | unit "models the records and stores none of them"; CLI "reads and writes nothing on a dry run" — entity count identical before and after |
| AC-6 one malformed record is skipped | PASS | "skips it, names it, and stores the rest" — a record the *domain* refuses, not one the contract excludes |
| AC-7 one derived repository entity per project | PASS | "derives the same id a foreign reference would"; integration reads the row back by id |
| AC-8 the graph survives real constraints | PASS | "stores the whole graph a pass produced" — four edge types read back from the database |
| AC-9 the same input twice writes one row | PASS | "writes one row for the same input twice" — entity count unchanged, `entitiesCreated: 0`, `evidenceRecorded: 0`, deduplication reported |
| AC-10 a remote edit supersedes without loss | PASS | "supersedes a remote edit without losing what it replaced" — both readings present, the old one `superseded` and pointing at the new, the entity updated |
| AC-11 the command is served, not planned | PASS | "is advertised without the planned marker"; "no longer exits 5"; `PLANNED_COMMANDS` is empty and `cli.test.ts` pins it |
| AC-12 an unconfigured Ferret refuses usefully | PASS | `E_CONFIG_INVALID` with a remediation naming `ferret.source.github` |
| AC-13 a configured tracker is read and stored | PASS | "synchronizes the configured project with no argument at all" — 1 issue, 1 pull request, 1 review, through `projects` in configuration and a `$secret` token |
| AC-14 the second pass asks only for what changed | PASS | "advances a cursor, so the second pass asks only for what changed" — the second request carries `since=` |
| AC-15 a dry run through the binary writes nothing | PASS | see AC-5 |
| AC-16 the pass is authorized as an ingestion | PASS | `cli-authorization.test.ts` — refusal at exit 7 naming `sync`, and the control that is not refused |
| AC-17 no credential reaches a stored row | PASS | "never writes the token anywhere it could be read back" — `entity.attributes`, `entity.unknown_fields` and `derived_artifact.metadata` scanned for the token |

## What was deliberately not done

- **No daemon.** D-113.2. The command's own output ends with the sentence
  `ferret reconcile` ends with, so an operator setting up a schedule reads it.
- **No credential at rest.** D-113.1, above.
- **No new conflict model.** D-113.3 instructed following the existing one, and
  `EvidenceStore.record` already implemented it. This Epic adds no supersession
  logic; AC-10 asserts the existing mechanism holds on the sync path.

## Known limitations

- Reviews cost one request per pull request; bounded at 50 per pass and reported
  as truncated beyond that.
- Only GitHub and Jira are composed; a third-party `source.project` provider
  loaded through `providerModules` is not reachable from this command, because
  its required construction options are not knowable from the core.
- Releases, deployments and comments are not ingested. The first two need a Git
  source alongside the tracker for EPIC-073's ancestry walk; the third has no
  canonical entity kind.
- A tracker's deletions are not observed, and no tracker endpoint reports one.

## Governance alignment

§4 — the synchronizer reaches no storage module; it takes the ports
`indexing/ports.ts` declares. §6 — `unsupported`, `unchanged` and `truncated` are
three distinct reported facts, none of them collapsed into an empty result. §10 —
a second identical pass writes nothing, measured. §12 — a record body is
untrusted text, carried verbatim and redacted by the model before it becomes an
attribute.
