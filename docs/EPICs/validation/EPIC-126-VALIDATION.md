# EPIC-126 — Context Merger: validation evidence

**Status: VALIDATED** · four fragmented records of one real Ferret decision
converge to one, with four observations intact. **No table added** — durable
context is a registered entity kind. One defect found by dogfooding and fixed;
one design defect found by a test and fixed.

## Environment

| | |
| --- | --- |
| Tree | `745a3f1` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Test database | PostgreSQL 17 + pgvector, per-file database from `tests/support/postgres.ts` |
| Dogfood database | `ferret-dogfood` — Ferret's own index, 5 819 entities, 19 912 evidence rows |
| Date | 2026-09-06 |

## Implementation

| | |
| --- | --- |
| Domain | `src/context/durable.ts` — identity, normalization, similarity, verdicts |
| Store | `src/storage/durable-context.ts` — `DurableContextStore` |
| Migration | `0016_durable_context.sql` — `attributes->>'statement'` into `search_vector` |
| Shared | `relaxedTsQuery` extracted from `src/storage/retrieval.ts` |
| Composition | `src/cli/commands/verify.ts` registers the kind |

No new table, no new dependency, no change to `EntityStore`, `EvidenceStore` or
`RelationshipStore`.

## Dogfood — Ferret's own index, real PostgreSQL

Every statement below is one this repository actually records, attributed to the
file that records it. Nothing was invented for the demonstration.

### The macOS constraint — four writers, four wordings

| Producer | Wording |
| --- | --- |
| `docs/EPICs/EPIC-105-Cross-Platform-Packaging.md` | The storage suites need a Linux container and macOS runners cannot run one |
| `docs/EPICs/validation/EPIC-105-VALIDATION.md` | The storage suites need a Linux container, and macOS runners cannot run one. |
| `docs/EPICs/validation/EPIC-115-VALIDATION.md` | the storage suites need a linux container and macos runners cannot run one |
| `agent-memory/no-macos-ci.md` | The storage suites need a Linux container␣␣and␣␣macOS␣␣runners␣␣cannot␣␣run␣␣one |

| | |
| --- | --- |
| Records created | **1** — `created, merged, merged, merged` |
| Supporting observations | **4**, every one `current` |
| Distinct producers retained | **4** |
| Canonical statement | the first writer's, unchanged |
| Replay of all four writes | 4 records → **4** records, no new evidence |

### Relate, never merge

`docs/EPICs/ROADMAP.md` — *"The storage suites need a Linux container, which
macOS runners cannot run"* — scored **0.786**, below the 0.8 threshold, and was
recorded as a **separate** record with no edge. The conservative direction, and
the one the design asks for: consolidating it would have been a guess.

The pair that *did* relate is real: *"CI runs the suite on Ubuntu, Windows and
macOS runners"* against *"CI runs the suite on Ubuntu and Windows runners only"*,
similarity **0.818**, `context_relates_to_context` with the score on the edge —
then explicitly superseded by the producer that replaced it.

### Supersession

| | |
| --- | --- |
| Current `fact` records after supersession | **1** |
| With `includeSuperseded` | **2** |
| Observations left on the superseded record | **1** — nothing deleted |
| `entity_supersedes_entity` edges | **1** |

### Totals on the dogfood index

```
context rows by lifecycle: active=3 superseded=1
edges: context_relates_to_context=1 entity_supersedes_entity=1
context evidence rows: 7
full-text hits for 'macOS runner linux container': 2
```

## Defects found and fixed

### 1 — `ferret verify` read every durable context row as corrupt

Found by dogfooding: **4 of 4** `context` rows reported `schema-invalid` on
Ferret's own index. `createEntity` refuses a kind the *current process* has not
registered, and `src/cli/commands/verify.ts` registered `code_symbol` and not
`context`.

This is the same defect the surrounding comment already records for
`code_symbol` — *"1 811 of them were reported as corrupt on Ferret's own index
for no reason but composition"* — one kind later. Fixed by registering it, and
covered by `verify-cli.test.ts › does not read a durable context row as
corrupt`, **proven against the unfixed code**: the test fails with
`schema-invalid` on the recorded row and passes with the registration.

After the fix, the sweep reports **0** findings against any `context` row.

### 2 — candidate detection could not find the duplicate that mattered

`candidates` first used `websearch_to_tsquery` directly, which builds a
*conjunction*. The near-duplicate a restatement most needs to find is the one
differing in exactly the word that matters, and an AND query can never retrieve
it: *"the page limit is twenty"* against *"…fifty"* are 0.82 similar and matched
nothing.

Caught by the contradiction integration test before merge. Fixed by sharing
`relaxedTsQuery` with `storage/retrieval.ts` rather than writing a second copy
of an expression that has been wrong before (F-65).

### 3 — a comma left one decision as two records

The first dogfood run converged four wordings to **two** records: the pair that
stayed apart differed by a single comma. `normalizeStatement` now drops `,;:`
where whitespace or the end follows, so `1,000` and `src:main` keep theirs.
Rejected: dropping punctuation everywhere, which changes what a statement
contains rather than how it is spelled. After the fix, four wordings → **one**
record.

## A separate defect this dogfood found, diagnosed and deferred to its own change

The dogfood index reports 196 findings unrelated to this Epic. A fresh database
sweeps clean in `durable-context.test.ts`, and a full re-index of Ferret's own
repository on this build did **not** clear them — the relationship count rose
from 101 to 112, so this is live rather than stale.

| Count | Subject |
| --- | --- |
| 112 | `relationship` content-hash-mismatch |
| 60 | `evidence-tampered`, all recorded 2026-09-01 |
| 24 | tombstoned `branch`, `file`, `code_symbol`, one `commit` |

**Diagnosed.** All 112 relationship findings are on **closed** rows — zero open
ones. The relationship content hash covers `validTo` (issue #118), and only
`IndexLifecycleStore.#retireContained` recomputes it. `RelationshipStore.retire`
and `#reconcileExclusive` both write `validTo` with a bare `UPDATE`, so every
relationship either of them closes disagrees with its own hash from then on.
Issue #118's fix landed on one of the three closing paths.

Fixed in the change that follows this one, with a regression test proven against
the unfixed code on both paths. Not folded in here, because it is not durable
context and combining them would make neither reviewable.

The 60 `evidence-tampered` rows are all from the index's first day, written by
builds predating EPIC-094's `canonicalInstant` fix.

## Suites

| Suite | Result |
| --- | --- |
| `tests/unit/durable-context.test.ts` | 27 passed |
| `tests/integration/storage/durable-context.test.ts` | 10 passed |
| `tests/integration/storage/verify-cli.test.ts` | 13 passed |
| `tests/unit/boundaries.test.ts` | 125 passed |
| lint · typecheck · build | clean |
