# EPIC-075 — Sync Cursor Management

**Status: APPROVED | Priority: P0 | Domain: Synchronization & Reconciliation**

> **Specification note.** Five documents park work here by name, and one is a
> direct instruction: *"when EPIC-075/076 land, replace `synchronization`"*
> (`Checkpoints/EPIC-004.md:94`). Authored to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).

## 1. Objective

Give every source one way to record where it got to, and make how far behind it
is a question an operator can ask.

## 2. Problem, measured

Ferret already resumes. `RepositoryIndexer` reads a watermark before a run and
writes one after (`src/indexing/indexer.ts:401`, `:631`), stored as an
EPIC-010 derived artefact and discarded when the producer version changes. That
mechanism is correct and this Epic does not replace it.

Three things are wrong with it as *the* answer.

**It is Git-shaped.** The stored position is `{ lastCommitAt }`, a commit
timestamp. Nothing else resumes that way: a Jira project resumes from
`updated >= t`, a paginated API from a page token, a webhook feed from an event
id. EPIC-071 is the next provider and would either bend its position into a
field named for commits or add a second mechanism beside this one.

**It is private to the indexer.** `#readWatermark` and `#writeWatermark` are
private methods on `RepositoryIndexer`. A second source cannot use them, and
nothing outside can read one — so no command can answer "when did this last
sync".

**Nobody can see it.** `plannedCapabilityComponents` reports:

```
synchronization  unknown  "No source synchronization is configured yet"
```

That is a hard-coded placeholder, and `Checkpoints/EPIC-004.md:94` names this
Epic as the thing that replaces it. `validation/EPIC-004-VALIDATION.md:151`
records the consequence: *"An operator cannot yet learn whether indexing is
behind."* EPIC-095 added an inventory reporting the last completed *run*; that
is not the same as how far behind each *source* is, and a run that succeeded
against a stale cursor looks identical to one that caught up.

## 3. Scope

1. **A cursor contract**: a position that is **opaque to the core** and
   meaningful to the provider that wrote it, keyed by source system and scope.
2. **A store** for cursors, reachable outside the indexer, with the staleness
   rule EPIC-031 already applies made explicit and shared.
3. **The Git watermark expressed through it**, so there is one mechanism rather
   than two — without changing what a Git run resumes from.
4. **`synchronization` becomes a real health component**, reporting per source
   when it last advanced and how long ago.

## 4. Non-scope

- **The synchronization loop itself** — EPIC-076. This Epic records position;
  that one decides when to read again.
- **Scheduling, timers, unattended runs** — EPIC-078, and EPIC-108 §4 already
  assigns them there.
- **Webhooks and event ingestion** — EPIC-077.
- **Changing what a Git run resumes from.** The position stays the newest
  commit timestamp; only where it lives and who can read it changes.
- **Reconciling out-of-order observations** — EPIC-031's validation assigns that
  to EPIC-076 (`validation/EPIC-031-VALIDATION.md:193`), and it stays there.
- **A new table.** `derived_artifact` already holds one current row per
  `(kind, scope_id)`, which is exactly a cursor's shape — the reason EPIC-094
  needed a *separate* table for run history is that a history is not a cursor.
- **Retention or pruning of cursors** — EPIC-088.

## 5. Inputs

`CompatibilityService` and `derived_artifact` (EPIC-010); the existing watermark
(EPIC-031); `plannedCapabilityComponents` and the health model (EPIC-004);
`ProviderKind` and the source capability (EPIC-011).

## 6. Outputs

- A `SyncCursorStore` with `read`, `advance` and `list`.
- The indexer's watermark reading and writing routed through it.
- A `synchronization` health component computed from real cursors.

## 7. Dependencies

EPIC-004, EPIC-010, EPIC-011, EPIC-031 — all VALIDATED. EPIC-095, IMPLEMENTED,
for where the health surface renders.

## 8. Contracts

### The position is opaque to the core

Ferret stores it and compares nothing inside it. A commit timestamp, a page
token and an event id are all just *the thing this provider needs to carry on*,
and a core that understood any of them would be a core that has to change when
the next source arrives — which Governance §4 exists to prevent.

The core does know **when** a cursor advanced, because that is a fact about
Ferret rather than about the source, and it is what "how far behind" is measured
from.

### A cursor advances only after the work it covers succeeded

EPIC-031's rule, kept: *"a run that failed halfway must be repeated, not resumed
from a position it never reached"*. The store makes advancing an explicit call
rather than a side effect, so it cannot happen by accident partway through.

### A cursor written by another build is not trusted

Also EPIC-031's rule, and now in one place instead of inline in the indexer: a
different producer version may read or model the source differently, and
resuming from its position would leave a gap nothing fills. Falling back to a
full read is the safe direction.

### One mechanism, not two

The Git watermark becomes the first cursor rather than a parallel thing beside
it. An abstraction with no current user is speculative; an abstraction whose
first user is the existing mechanism is a generalisation.

## 9. Acceptance criteria

- **AC-1** A cursor is stored per `(sourceSystem, scopeId)` and read back
  unchanged, with its position untouched by the core.
- **AC-2** `advance` is explicit; nothing advances a cursor as a side effect of
  reading it.
- **AC-3** A cursor written by a different producer version is not returned, and
  the caller sees "no cursor" rather than a stale one.
- **AC-4** `list` returns every cursor with when it last advanced, for the
  health surface.
- **AC-5** A Git run resumes from exactly what it resumed from before — proved
  by the existing incremental tests passing unchanged.
- **AC-6** The indexer holds no private watermark logic; reading and writing go
  through the store.
- **AC-7** `synchronization` reports a real status: `ok` with the newest and
  oldest cursor age when sources are current, `unknown` when nothing has synced,
  and never a hard-coded string.
- **AC-8** A source that has never synced is reported as never synced, not as
  zero seconds behind.
- **AC-9** The two EPIC-004 records naming this Epic are discharged or restated.

## 10. Test requirements

- **Integration, real PostgreSQL** — AC-1 to AC-4 and AC-8 against the store.
- **Regression** — AC-5 and AC-6 by the existing indexing suites passing with no
  change to their assertions. A change to what a run resumes from would show up
  there, which is why this Epic adds no new incremental test.
- **Health** — AC-7 in both states.

## 11. Security requirements

A position is provider data and may name a branch, a project key or a URL. It is
stored and returned; it reaches a log only through the existing redactor, and
the health component reports **ages and counts**, never positions — the rule
EPIC-094 §11 set for findings.

## 12. Observability

AC-7 is the observability. "How far behind is Ferret" is the question this Epic
exists to make answerable.

## 13. Performance constraints

One row read per source before a run and one write after — the cost the
watermark already has. `list` is one query for the health surface.

## 14. Definition of Done

Acceptance criteria satisfied; `npm run verify` green; a validation document;
the registry updated; the EPIC-004 records discharged.

## 15. Governance alignment

- **§4 Provider-First** — an opaque position is what lets a second source
  arrive without a core change.
- **§10** — resuming is what makes ingestion incremental.
- **§6** — never synced and synced-just-now must not look the same.
- **§20** — synchronization becomes inspectable.

## 16. Raised, not absorbed

- **Only one provider will use this.** Git is the only source Ferret has, so the
  generalisation is justified by the existing mechanism being expressed through
  it rather than by a second caller. If EPIC-071 arrives and needs something
  this shape does not offer, that is the point at which the shape is wrong and
  should change.
- **`synchronization` will report on Git alone**, and should say so rather than
  implying it covers sources Ferret does not have.
