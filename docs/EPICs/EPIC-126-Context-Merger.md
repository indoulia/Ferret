# EPIC-126 — Context Merger

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

Repeated, fragmented and superseded durable context converges to one canonical
record, while every observation that produced it stays intact and attributable.

## Problem

Ferret's source mirror was already sound: evidence immutable and attributed,
authority ranked, supersession and conflict modelled, permission carried on the
observation. Measured on the dogfood index on 2026-09-06 — 10 391 current and
9 521 superseded evidence rows, 0 conflicting.

The tier above it did not exist. The same index held **one** engineering memory
for 208 commits, 139 pull requests and 49 issues, because
`engineeringMemoryKey(sessionId, kind, statement)` puts the **author** in the
identity: two sessions recording one decision produce two rows by construction.
So Ferret's own durable knowledge lived in `docs/`, in PR bodies and in agent
memory files outside the product — the decision "the storage suites need a Linux
container and macOS runners cannot run one" written in four places, none of them
in Ferret and none aware of the others.

## Design

Evidence is keyed on *who observed it*; durable context is keyed on *what is
said*. That change of key is the merge. `docs/Architecture/EPIC-126-DECISIONS.md`
records the reasoning; the short version:

- A durable context record is an **entity** of the registered kind `context`
  (`registerEntityKind`, as `code_symbol` is), so storage, relationships,
  retrieval, scope filtering and the integrity sweep work unchanged and **no
  table is added**.
- Identity is `digest(contextKind, subjectId, normalize(statement))` under a
  scope. Merging is a property of the identifier: no scan, no comparison against
  the corpus, no cost that grows with it.
- The record carries no confidence, authority or observation time. Those live on
  the evidence each write emits against it.
- **Same** merges. **Near** (token-set Jaccard ≥ 0.8) only relates. Nothing
  consolidates on a score.
- A contradiction keeps both sides and picks no winner.

## Scope

- Durable context identity, normalization and the `context` entity kind.
- Merge on write; provenance recorded as evidence.
- Bounded near-duplicate detection and `context_relates_to_context`.
- Contradiction preserved as `context_contradicts_context`.
- Supersession through `ENTITY_SUPERSEDES_ENTITY`, evidence untouched.
- Current-versus-historical reads.
- Migration `0016`: `attributes->>'statement'` reaches the entity search vector.

## Non-scope

- Judging whether a statement deserves to be durable — EPIC-129.
- The full lifecycle state machine — EPIC-127.
- Any agent-facing MCP tool or CLI command — EPIC-128.
- Task-ready context assembly — EPIC-131.
- Any use of a model inside the merger.

## Contracts

`DurableContextStore` — `record`, `get`, `current`, `candidates`, `supersede`,
`relatedTo`, `count`. `context/durable.ts` — `createDurableContext`,
`normalizeStatement`, `similarity`, `classifyPair`, `contradicts`,
`registerDurableContextKind`, `NEAR_DUPLICATE_SIMILARITY`, `MAX_CANDIDATES`.

Invariants other Epics may rely on:

1. Two writers of the same statement, in the same scope and kind, about the same
   subject, address the same record.
2. A record's canonical wording is the first writer's and does not change.
3. Every write leaves exactly one evidence record, `cardinality: 'collection'`,
   so corroboration is never read as supersession.
4. Nothing is merged on similarity; nothing is deleted on supersession.

## Acceptance criteria

- **AC-1** Repeated statements converge to one record. *Dogfood: 4 writers → 1
  record, 4 current observations.*
- **AC-2** Replaying every write creates nothing. *Dogfood: 4 records → 4.*
- **AC-3** A near-duplicate is related, never merged.
- **AC-4** A contradiction keeps both sides active and names no winner.
- **AC-5** A superseded record leaves current reads and keeps its evidence.
- **AC-6** Durable context is reachable by full-text retrieval.
- **AC-7** A credential never reaches a statement or an identifier.
- **AC-8** `ferret verify` reports no finding against a healthy context row.
- **AC-9** Candidate detection is bounded and does not scale with the corpus.

## Test requirements

`tests/unit/durable-context.test.ts` — 27 cases over identity, normalization,
similarity, verdicts, contradiction and refusals.
`tests/integration/storage/durable-context.test.ts` — 10 cases against real
PostgreSQL: convergence, deduplication, authority, relate-not-merge,
contradiction, supersession, integrity, scope isolation, full-text, refusals.
`tests/integration/storage/verify-cli.test.ts` — the composition regression.

## Security requirements

`redactSecrets` runs before the id is derived. Statement length is bounded and
an over-length statement is refused, not truncated. Every write carries
`permissionScope` on its evidence; `source.scope` is the repository id, so
existing scope filtering applies with no new code. No second authorization
architecture.

## Definition of Done

Design record written before implementation; unit and integration suites green;
lint, typecheck and build clean; dogfood evidence against Ferret's own index
recorded in `validation/EPIC-126-VALIDATION.md`; defects found by dogfooding
fixed rather than documented.
