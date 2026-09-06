# EPIC-134 — Continuous Self-Dogfooding

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

`npm run dogfood` asks Ferret about Ferret — including the durable context an
agent depends on — and checks every answer against one computed independently.
Running it is how the defects fixtures miss get found.

## What this Epic is not

> Self-dogfooding is an acceptance discipline across the roadmap, not a separate
> product or agent workflow.

So no framework was built. EPIC-118 already made `scripts/dogfood.mjs` an
**oracle**: every question has an answer produced independently of Ferret, and
every question goes through the MCP surface rather than SQL, because *"a defect
that only SQL can see is not a defect a client will ever hit."*

This Epic extends that oracle to the tier EPIC-126 to EPIC-133 built. Six checks
are added to a script that already had nine. Nothing else.

## Why the oracle discipline transfers

An oracle needs a truth Ferret did not produce. For the repository questions
that is `git`. For durable context it is **normalization computed in the script
itself**: the number of distinct statements four wordings reduce to is arithmetic
the script does, and Ferret is then asked how many records it holds. A
disagreement is a defect rather than a matter of opinion.

| Check | The independent answer |
| --- | --- |
| durable context converges | distinct normalized forms, computed in the script |
| replay adds nothing | the ids held before the replay |
| every statement stays reachable | the count recorded |
| a statement can say why it is believed | the record exists and is current |
| a proposal is not current context | the id just proposed |
| the notice precedes the content | byte offsets in the rendered response |

## A skip is a third outcome

`record` is not granted by default, and should not be — EPIC-068 makes a Ferret
nobody configured the restricted one. So the durable-context checks report
themselves **skipped, with the remediation**, where nobody has granted it:

```
skip  durable context
      this principal does not hold `record`. Grant it to exercise the
      durable context surface:
      ferret config set authorization.permissions '["read","record","mutate"]'
```

A check that quietly did not run reads exactly like one that passed, so the
summary counts skips separately and names them.

## Scope

- Six durable-context checks in `scripts/dogfood.mjs`.
- A `skip` outcome, counted and named in the summary.
- The record of what dogfooding found across this queue, and the regression test
  each finding became.

## Non-scope

- Any autonomous agent framework, scheduler or orchestration.
- A second dogfood harness. There is one, and it grew.
- Making dogfooding a CI gate. It needs a real repository and a real database;
  the reproducible command is the deliverable, not a job.

## Acceptance criteria

- **AC-1** `npm run dogfood` exercises ingestion, curation, retrieval and the
  agent context surface against Ferret's own repository.
- **AC-2** Every durable-context check has an answer the script computes itself.
- **AC-3** A check that cannot run reports itself skipped, with remediation, and
  is counted separately.
- **AC-4** The probe writes a statement worth holding rather than a throwaway.
- **AC-5** Every defect dogfooding found in this queue has a regression test.

## Test requirements

The oracle is the test, and it is run rather than asserted. The regression
coverage its findings became is enumerated in
`validation/EPIC-134-VALIDATION.md`, each naming the suite that now holds it.

## Definition of Done

The oracle runs clean against Ferret's own index; the findings table is complete
and every row names a shipped regression test.
