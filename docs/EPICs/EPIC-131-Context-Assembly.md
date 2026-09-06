# EPIC-131 — Context Assembly

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

A concrete task produces a package that says what constrains the work before it
says which records matched — coherent, bounded, and carrying the provenance of
everything in it.

## Problem, measured

`ContextPackBuilder` (EPIC-054) already assembled a bounded pack of ranked
records. Asked a real task question — *"Should CI add a macOS runner for the
storage suites?"* — against an index holding **seven** durable statements
directly about it, the pack contained **none of them**.

Two causes, both measured:

- **A task is a sentence.** Full text ANDs every term, and no statement contains
  all of `ci & add & maco & runner & storag & suit`. The strict query matched
  **one incidental commit** and nothing else.
- **The planner's widening did not fire**, because it relaxes only when
  *nothing* matched — and something had.

So the surface whose whole purpose is task-readiness was the one that could not
find the context bearing on the task.

## Design

**A section, not another ranked item.** A decision sitting seventh in a list of
files is not task-ready. `ContextPack` gains `standing`: what Ferret currently
holds that bears on the task, ahead of the records. The records are unchanged
below it.

**Assembly arranges; it does not merge.** The Epic states the separation and
this keeps it: nothing here decides what is the same as what. The restatements
EPIC-130 folded are carried on each entry as `restates` rather than re-decided,
and trust is read through `preferredEvidence` — the same function EPIC-127's
`trust` uses — so a package and a trust report cannot disagree.

**Ordered by what acting against it costs**, not by relevance:

```
constraint → decision → gotcha → preference → fact → next-step
```

Breaking a constraint is worse than contradicting a decision, which is worse
than being ignorant of a fact. Current always precedes historical. Relevance is
deliberately not a key — retrieval already decided which of these belong to the
question, and re-ranking by score would put a well-worded fact above a
constraint.

**One widened query, and only here.** The standing read relaxes; `ferret_search`
is untouched. It is safe in this one place in a way a global relaxation is not:
the corpus is curated statements rather than file contents, EPIC-130 has already
folded the restatements, the ordering is by cost rather than score, and the
section is capped at `MAX_STANDING_CONTEXT`.

## Scope

- `ContextPack.standing`, and `src/context/standing.ts`.
- A targeted, widened durable-context read inside `ContextPackBuilder`.
- Rendering: what constrains the task, after the notice and before the records.

## Non-scope

- Deciding what is the same as what — EPIC-126, and consumed here.
- Changing how `ferret_search` retrieves. It is untouched.
- Changing how records are ranked, trimmed or budgeted.

## Rejected

**Wiring the pack builder to `QueryPlanner`.** Tried, and reverted: the planner
relaxes only when the strict query returns nothing, and here it returned one
incidental commit, so the change did not fix what it claimed to. Shipping it
would have been a behaviour change to `ferret_context_pack` with a stated
motivation the measurement had already disproved.

## Acceptance criteria

- **AC-1** A task question reaches durable context a strict search cannot.
- **AC-2** Constraints precede decisions; decisions precede next steps.
- **AC-3** Current precedes historical, whatever the kind.
- **AC-4** Restatements folded by retrieval are carried, not dropped.
- **AC-5** A parsed source outranks an asserted one within a kind.
- **AC-6** The package stays inside its budget and reports what did not fit.
- **AC-7** Rendering puts the notice first, then what constrains, then records.
- **AC-8** A proposal is never presented as something Ferret holds.
- **AC-9** Ordering is total, so two builds of one pack agree.

## Test requirements

`tests/unit/context-standing.test.ts` — 12 cases over the pure entry and its
ordering. `tests/integration/retrieval/task-assembly.test.ts` — 7 cases against
real PostgreSQL, including the one that proves the defect: the strict search
returns nothing while the pack finds the context.

## Security requirements

Every statement is contained before it enters a package, and the notice precedes
it in the rendered form. Support is read through the same `EvidenceReader` the
items use, with the caller's permitted scopes, so a package cannot report a
statement as supported by evidence the caller was refused. The standing read is
filtered by kind **defensively** rather than trusting the port to have honoured
the filter.

## Definition of Done

Targeted and full suites green; lint, typecheck, build clean; a real task
assembled against Ferret's own index in `validation/EPIC-131-VALIDATION.md`.
