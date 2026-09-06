# EPIC-127 — Context Lifecycle & Authority: validation evidence

**Status: VALIDATED** · a proposal is held back while it gathers support, a
parsed source outranks an asserted one about the same fact, a superseded record
says so and names its replacement, and every transitioned row still verifies.
**No migration** — `entity.lifecycle` is unconstrained `text`.

## Environment

| | |
| --- | --- |
| Tree | `68a56b4` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Test database | PostgreSQL 17 + pgvector, per-file database |
| Dogfood database | `ferret-dogfood`, **rebuilt from scratch** on `68a56b4` — 5 757 entities, 10 289 relationships |
| Date | 2026-09-06 |

## Implementation

| | |
| --- | --- |
| States | `src/domain/kinds.ts` — `CANDIDATE`, `ARCHIVED`, `HISTORICAL_LIFECYCLE_STATES` |
| Standing | `src/retrieval/freshness.ts` — two bands, two explanations |
| Transitions | `src/storage/durable-context.ts` — `accept`, `archive`, `reinstate`, shared `#transition` |
| Trust | same — `DurableContextStore.trust`, `ContextTrust` |
| Reads | same — `ContextQuery.states` |

## Dogfood — Ferret's own index

Statements taken from this repository's own records, attributed to the file that
holds each one.

### A proposal is not current context

`docs/EPICs/ROADMAP.md` proposes *"Ferret should assemble task-ready context
rather than return a pile of records"* as a candidate.
`agent-memory/roadmap-notes.md` then states the same thing as an assertion.

| | |
| --- | --- |
| State after the second writer | **candidate** — a restatement is support, not a decision |
| Support accumulated meanwhile | **2** observations |
| In current context | **no** |
| After `accept` | **active**, with both observations intact |

### Authority decides, and says so

Two real sources for one constraint: `EPIC-105-Cross-Platform-Packaging.md`
(read as `parsed`) and `agent-memory/no-macos-ci.md` (`asserted`).

```
support                2
authority preferred    60   (SourceAuthority.PARSED)
method                 parsed
undecided              false
reason                 current on 2 observation(s), strongest by parsed
```

The parsed source wins on `AUTHORITY_BY_METHOD` — a producer cannot promote
itself past what Ferret saw.

### Supersession, both sides

| | |
| --- | --- |
| Superseded record — current | **no** |
| Its reason | *replaced by a later statement, which is the answer instead* |
| Its evidence | **1** observation, retained |
| Replacement — current | **yes**, naming **1** record it supersedes |

### Archiving retires without deleting

| | |
| --- | --- |
| After `archive` — in current context | **no** |
| Evidence retained | **1** |
| After `reinstate` | **active** |

### Current versus historical, explicitly

```
current context     3
historical context  2
every state         5
by lifecycle        active=3 archived=1 superseded=1
```

### Integrity

```
integrity findings across the whole index    0
```

Zero, with `archived` and `superseded` context rows present — so the content
hash was recomputed on every transition (issue #118).

## The relationship-hash fix, proven on real data

The dogfood index was rebuilt from scratch on `68a56b4`, which carries #200.

| | Before (`659c69b`) | After (`68a56b4`, fresh) |
| --- | --- | --- |
| Relationship `content-hash-mismatch` | **112** | **0** |
| Closed relationships present | 112 | **14** |
| Total sweep findings | 196 | **0** |

Non-vacuous: there are 14 closed relationships in the fresh index for the fix to
get wrong, and it does not.

The rebuild was needed for a second reason worth recording. The old dogfood
database had applied a draft of migration `0016` — the one whose speculative
index was removed before merge — and Ferret's schema-drift guard refused to run
against it, naming both checksums and the remediation. The guard behaved
correctly, on a database no released build ever produced.

## Suites

| Suite | Result |
| --- | --- |
| `tests/integration/storage/context-lifecycle.test.ts` | 13 passed |
| `tests/unit/retrieval-freshness.test.ts` | 19 passed |
| `tests/integration/storage/durable-context.test.ts` | 10 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
